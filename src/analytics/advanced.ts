import { bucketize, groupBy, lowerBound, slice } from '../aggregate.js';
import { priceFor } from '../pricing.js';
import { clamp, linearTrend, mean, median, quantile } from '../stats.js';
import { DAY, HOUR, type Clock } from '../time.js';
import { addEntry, emptyTotals, metricOf, type Entry, type Metric, type Totals } from '../types.js';
import type { Profile } from './baseline.js';
import type { CycleStatus } from './cycle.js';

/** Deterministic PRNG so the same data always gives the same probabilities. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Monte Carlo limit risk
// ---------------------------------------------------------------------------------------------

export interface Risk {
  key: string;
  /** Probability of reaching 100% before the window resets. */
  pHit: number;
  /** Usage at reset as a share of the limit: 10th / 50th / 90th percentile. */
  p10: number;
  p50: number;
  p90: number;
  /** Median time the limit is reached, among simulations that reach it. */
  etaP50?: number;
  sims: number;
  /** Projection fan for charts: time, then p10 / p50 / p90 of cumulative share. */
  fan: { t: number; p10: number; p50: number; p90: number }[];
  method: string;
}

/**
 * Simulates the rest of a cycle thousands of times. Each simulated day draws a "how intense was
 * this day vs. my normal" multiplier from the user's own history (block bootstrap by day, so bursty
 * days stay bursty), applied to the learned hour-of-week profile. The current day blends the
 * observed intensity of the last 24h with a draw. Short windows resample real active-hour burn
 * rates instead. The output is a probability, not a single line.
 */
export function simulateRisk(
  cycle: CycleStatus,
  entries: Entry[],
  profile: Profile,
  clock: Clock,
  now: number,
  sims = 2000,
): Risk | undefined {
  if (!cycle.limitCost || cycle.limitCost <= 0 || cycle.end <= now || cycle.elapsed >= 1) return undefined;
  const used = cycle.used ?? cycle.usedCost / cycle.limitCost;
  const limit = cycle.limitCost;
  const rnd = mulberry32(Math.floor(cycle.start / 1000) ^ 0x9e3779b9);
  const remaining = cycle.end - now;
  const short = cycle.end - cycle.start <= DAY;
  const steps = Math.max(1, Math.min(short ? 20 : 56, Math.ceil(remaining / (short ? 15 * 60_000 : 3 * HOUR))));
  const stepMs = remaining / steps;
  const paths: number[][] = [];
  const ends: number[] = [];
  const etas: number[] = [];
  let hits = 0;

  if (short) {
    // Two-state Markov chain learned from the last 30 days of hours: does an active hour continue,
    // does an idle hour wake up, and how much does an active hour cost. The live burn rate only
    // shapes the current hour, so one hot minute cannot dominate a 5-hour projection.
    const hours = bucketize(entries, clock, 'hour', now - 30 * DAY, clock.bucketStart(now, 'hour')).map((x) => x.cost);
    const activeCosts = hours.filter((v) => v > 0);
    let aa = 0, a = 0, ia = 0, i = 0;
    for (let k = 1; k < hours.length; k++) {
      if (hours[k - 1] > 0) {
        a++;
        if (hours[k] > 0) aa++;
      } else {
        i++;
        if (hours[k] > 0) ia++;
      }
    }
    if (activeCosts.length < 10 || !a) return undefined;
    const pCont = aa / a;
    const pWake = i ? ia / i : 0;
    const current = cycle.burnPerHour;
    const hourStart = clock.bucketStart(now, 'hour');
    for (let s = 0; s < sims; s++) {
      let acc = used * limit;
      const path: number[] = [];
      let hit: number | undefined;
      let active = current > 0;
      let rate = active ? 0.6 * current + 0.4 * activeCosts[Math.floor(rnd() * activeCosts.length)] : 0;
      let hourKey = hourStart;
      for (let k = 0; k < steps; k++) {
        const t0 = now + k * stepMs;
        const hk = hourStart + Math.floor((t0 - hourStart) / HOUR) * HOUR;
        if (hk !== hourKey) {
          hourKey = hk;
          active = rnd() < (active ? pCont : pWake);
          rate = active ? activeCosts[Math.floor(rnd() * activeCosts.length)] : 0;
        }
        acc += rate * (stepMs / HOUR);
        path.push(acc / limit);
        if (hit === undefined && acc >= limit) hit = t0 + stepMs;
      }
      paths.push(path);
      ends.push(acc / limit);
      if (hit !== undefined && used < 1) {
        hits++;
        etas.push(hit);
      }
    }
  } else {
    // Day-level intensity multipliers vs. the learned profile, last 56 days.
    const days = bucketize(entries, clock, 'day', Math.max(now - 56 * DAY, entries[0]?.t ?? now), clock.bucketStart(now, 'day'));
    const mult: number[] = [];
    for (const d of days) {
      const exp = profile.dayTotal(clock.weekIndex(clock.parts(d.start)));
      if (exp > 0) mult.push(d.cost / exp);
    }
    if (mult.length < 7) return undefined;
    const exp24 = profile.expectedBetween(now - DAY, now);
    const act24 = sumCost(entries, now - DAY, now);
    const today = exp24 > 0 ? clamp(act24 / exp24, 0.2, 5) : 1;
    const family = cycle.family;
    const all7 = sumCost(entries, now - 7 * DAY, now);
    const share = family ? (all7 > 0 ? sumCost(entries, now - 7 * DAY, now, family) / all7 : 0) : 1;
    for (let s = 0; s < sims; s++) {
      let acc = used * limit;
      const path: number[] = [];
      let hit: number | undefined;
      let dayKey = -1;
      let m = 1;
      for (let k = 0; k < steps; k++) {
        const t0 = now + k * stepMs;
        const dk = clock.bucketStart(t0, 'day');
        if (dk !== dayKey) {
          const draw = mult[Math.floor(rnd() * mult.length)];
          m = dayKey === -1 ? 0.6 * today + 0.4 * draw : draw;
          dayKey = dk;
        }
        acc += profile.expectedBetween(t0, t0 + stepMs) * m * share;
        path.push(acc / limit);
        if (hit === undefined && acc >= limit) hit = t0 + stepMs;
      }
      paths.push(path);
      ends.push(acc / limit);
      if (hit !== undefined && used < 1) {
        hits++;
        etas.push(hit);
      }
    }
  }
  const fan: Risk['fan'] = [];
  for (let k = 0; k < steps; k++) {
    const col = paths.map((p) => p[k]);
    fan.push({ t: now + (k + 1) * stepMs, p10: quantile(col, 0.1), p50: quantile(col, 0.5), p90: quantile(col, 0.9) });
  }
  return {
    key: cycle.key,
    pHit: used >= 1 ? 1 : hits / sims,
    p10: quantile(ends, 0.1),
    p50: quantile(ends, 0.5),
    p90: quantile(ends, 0.9),
    etaP50: etas.length ? median(etas) : undefined,
    sims,
    fan,
    method: short ? 'Markov chain of active/idle hours with bootstrapped hourly burn (30 days)' : 'day-level bootstrap of intensity vs. your profile (56 days)',
  };
}

function sumCost(entries: Entry[], from: number, to: number, family?: string): number {
  let c = 0;
  for (let i = lowerBound(entries, from); i < entries.length && entries[i].t < to; i++)
    if (!family || entries[i].model.includes(family)) c += entries[i].cost;
  return c;
}

// ---------------------------------------------------------------------------------------------
// Burn-down (cumulative usage within a cycle)
// ---------------------------------------------------------------------------------------------

export interface Burndown {
  key: string;
  start: number;
  end: number;
  /** Cumulative share of the limit at each step so far. */
  actual: { t: number; v: number }[];
}

export function burndown(cycle: CycleStatus, entries: Entry[], now: number): Burndown | undefined {
  if (!cycle.limitCost || cycle.end <= cycle.start) return undefined;
  const len = cycle.end - cycle.start;
  const step = len <= DAY ? 15 * 60_000 : 3 * HOUR;
  const actual: Burndown['actual'] = [{ t: cycle.start, v: 0 }];
  // Scale local logs so the last point matches the meter (which may include other devices).
  const localTotal = sumCost(entries, cycle.start, now, cycle.family);
  const target = cycle.used !== undefined ? cycle.used * cycle.limitCost : localTotal;
  const scale = localTotal > 0 ? target / localTotal : 1;
  let acc = 0;
  let i = lowerBound(entries, cycle.start);
  for (let t = cycle.start + step; t < now + step; t += step) {
    const until = Math.min(t, now);
    for (; i < entries.length && entries[i].t < until; i++)
      if (!cycle.family || entries[i].model.includes(cycle.family)) acc += entries[i].cost;
    actual.push({ t: until, v: (acc * scale) / cycle.limitCost });
  }
  return { key: cycle.key, start: cycle.start, end: cycle.end, actual };
}

// ---------------------------------------------------------------------------------------------
// Regime / change-point detection
// ---------------------------------------------------------------------------------------------

export interface ChangePoint {
  at: number;
  label: string;
  before: number;
  after: number;
  change: number;
  /** Welch-style t statistic on log usage. */
  strength: number;
}

/**
 * Finds the single most significant level shift in daily usage over the last 90 days
 * (log-scale, minimum 7 days on each side). Answers "when did my usage pattern change?".
 */
export function detectChangePoint(entries: Entry[], clock: Clock, metric: Metric, now: number): ChangePoint | undefined {
  const today = clock.bucketStart(now, 'day');
  const days = bucketize(entries, clock, 'day', Math.max(today - 90 * DAY, entries[0] ? clock.bucketStart(entries[0].t, 'day') : today), today);
  const n = days.length;
  if (n < 21) return undefined;
  const y = days.map((d) => Math.log1p(metricOf(d, metric)));
  let best: { k: number; t: number } | undefined;
  for (let k = 7; k <= n - 7; k++) {
    const a = y.slice(0, k);
    const b = y.slice(k);
    const ma = mean(a);
    const mb = mean(b);
    const va = a.reduce((s, v) => s + (v - ma) ** 2, 0) / (a.length - 1);
    const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (b.length - 1);
    const t = Math.abs(mb - ma) / Math.sqrt(va / a.length + vb / b.length + 1e-9);
    if (!best || t > best.t) best = { k, t };
  }
  if (!best || best.t < 4) return undefined;
  const before = median(days.slice(0, best.k).map((d) => metricOf(d, metric)));
  const after = median(days.slice(best.k).map((d) => metricOf(d, metric)));
  const change = before > 0 ? (after - before) / before : Infinity;
  if (Number.isFinite(change) && Math.abs(change) < 0.3) return undefined;
  return { at: days[best.k].start, label: days[best.k].label, before, after, change, strength: best.t };
}

// ---------------------------------------------------------------------------------------------
// Cost anatomy, context economics, sessions, breakdowns
// ---------------------------------------------------------------------------------------------

export interface CostAnatomy {
  input: number;
  output: number;
  thinking: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  total: number;
  /** Cost the same traffic would have had with no prompt caching. */
  withoutCache: number;
  byModel: { model: string; input: number; output: number; cacheWrite: number; cacheRead: number; total: number }[];
}

export function costAnatomy(entries: Entry[]): CostAnatomy {
  const a: CostAnatomy = { input: 0, output: 0, thinking: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: 0, withoutCache: 0, byModel: [] };
  const per = new Map<string, CostAnatomy['byModel'][number]>();
  for (const e of entries) {
    const p = priceFor(e.model, e.speed);
    if (!p) continue;
    const prompt = e.input + e.cacheWrite5m + e.cacheWrite1h + e.cacheRead;
    const r = p.above && prompt > p.above.threshold ? p.above : p;
    const ci = (e.input * r.input) / 1e6;
    const co = (e.output * r.output) / 1e6;
    const ct = ((e.thinking ?? 0) * r.output) / 1e6;
    const c5 = (e.cacheWrite5m * r.cacheWrite) / 1e6;
    const c1 = (e.cacheWrite1h * r.input * 2) / 1e6;
    const cr = (e.cacheRead * r.cacheRead) / 1e6;
    a.input += ci;
    a.output += co;
    a.thinking += ct;
    a.cacheWrite5m += c5;
    a.cacheWrite1h += c1;
    a.cacheRead += cr;
    a.withoutCache += (prompt * r.input) / 1e6 + co;
    let m = per.get(e.model);
    if (!m) per.set(e.model, (m = { model: e.model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 }));
    m.input += ci;
    m.output += co;
    m.cacheWrite += c5 + c1;
    m.cacheRead += cr;
    m.total += ci + co + c5 + c1 + cr;
  }
  a.total = a.input + a.output + a.cacheWrite5m + a.cacheWrite1h + a.cacheRead;
  a.byModel = [...per.values()].sort((x, y) => y.total - x.total);
  return a;
}

export interface ContextEconomics {
  /** Prompt (input + all cache) tokens per request. */
  promptP50: number;
  promptP90: number;
  promptP99: number;
  /** Requests with prompts above 200k tokens and their share of cost. */
  over200kShare: number;
  over200kCostShare: number;
  /** Typical prompt growth per request inside a session (tokens/turn). */
  growthPerTurn: number;
  /** Each cache-written token is read this many times on average. */
  cacheReuse: number;
  cacheHitRate: number;
  thinkingShareOfOutput: number;
  /** Cost of the context re-sent above 100k tokens: the part /compact or /clear could save. */
  heavyContextCost: number;
}

export function contextEconomics(entries: Entry[]): ContextEconomics {
  const prompts: number[] = [];
  let over = 0;
  let overCost = 0;
  let total = 0;
  let cw = 0;
  let cr = 0;
  let inp = 0;
  let out = 0;
  let think = 0;
  let heavy = 0;
  const bySession = new Map<string, number[]>();
  for (const e of entries) {
    const prompt = e.input + e.cacheWrite5m + e.cacheWrite1h + e.cacheRead;
    prompts.push(prompt);
    total += e.cost;
    if (prompt > 200_000) {
      over++;
      overCost += e.cost;
    }
    cw += e.cacheWrite5m + e.cacheWrite1h;
    cr += e.cacheRead;
    inp += e.input;
    out += e.output;
    think += e.thinking ?? 0;
    if (prompt > 100_000) {
      const p = priceFor(e.model, e.speed);
      if (p) heavy += ((Math.min(e.cacheRead, prompt - 100_000)) * p.cacheRead) / 1e6;
    }
    if (!e.subagent) {
      let arr = bySession.get(e.sessionId);
      if (!arr) bySession.set(e.sessionId, (arr = []));
      arr.push(prompt);
    }
  }
  const slopes: number[] = [];
  for (const arr of bySession.values()) {
    if (arr.length < 10) continue;
    const s = linearTrend(arr.slice(0, 400)).slope;
    if (Number.isFinite(s)) slopes.push(s);
  }
  const promptAll = inp + cw + cr;
  return {
    promptP50: quantile(prompts, 0.5),
    promptP90: quantile(prompts, 0.9),
    promptP99: quantile(prompts, 0.99),
    over200kShare: prompts.length ? over / prompts.length : 0,
    over200kCostShare: total ? overCost / total : 0,
    growthPerTurn: slopes.length ? median(slopes) : 0,
    cacheReuse: cw ? cr / cw : 0,
    cacheHitRate: promptAll ? cr / promptAll : 0,
    thinkingShareOfOutput: out ? think / out : 0,
    heavyContextCost: heavy,
  };
}

export interface SessionStats {
  /** Working runs: a session split at idle gaps of 2h+, with at least 2 requests. */
  count: number;
  durationP50: number;
  durationP90: number;
  costP50: number;
  costP90: number;
  costMax: number;
  requestsP50: number;
  /** Single-request sessions (claude -p, automations, title generation…). */
  oneShot: number;
  oneShotCostShare: number;
  subagentCostShare: number;
  top: { sessionId: string; project: string; start: number; end: number; cost: number; requests: number; model: string }[];
}

export function sessionStats(entries: Entry[]): SessionStats {
  type Run = { sessionId: string; project: string; start: number; end: number; cost: number; requests: number; models: Map<string, number> };
  const runs: Run[] = [];
  const open = new Map<string, Run>();
  let sub = 0;
  let total = 0;
  for (const e of entries) {
    total += e.cost;
    if (e.subagent) sub += e.cost;
    let r = open.get(e.sessionId);
    if (!r || e.t - r.end > 2 * HOUR) {
      r = { sessionId: e.sessionId, project: e.project, start: e.t, end: e.t, cost: 0, requests: 0, models: new Map() };
      open.set(e.sessionId, r);
      runs.push(r);
    }
    r.end = Math.max(r.end, e.t);
    r.cost += e.cost;
    r.requests++;
    r.models.set(e.model, (r.models.get(e.model) ?? 0) + e.cost);
  }
  const multi = runs.filter((r) => r.requests >= 2);
  const single = runs.filter((r) => r.requests < 2);
  const dur = multi.map((r) => r.end - r.start);
  const cost = multi.map((r) => r.cost);
  return {
    count: multi.length,
    durationP50: quantile(dur, 0.5),
    durationP90: quantile(dur, 0.9),
    costP50: quantile(cost, 0.5),
    costP90: quantile(cost, 0.9),
    costMax: Math.max(0, ...cost),
    requestsP50: quantile(multi.map((r) => r.requests), 0.5),
    oneShot: single.length,
    oneShotCostShare: total ? single.reduce((a, r) => a + r.cost, 0) / total : 0,
    subagentCostShare: total ? sub / total : 0,
    top: multi
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 8)
      .map((r) => ({
        sessionId: r.sessionId,
        project: r.project,
        start: r.start,
        end: r.end,
        cost: r.cost,
        requests: r.requests,
        model: [...r.models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
      })),
  };
}

/** Turn the deep metrics into short, actionable findings. */
export function advancedInsights(a: { anatomy: CostAnatomy; context: ContextEconomics; sessions: SessionStats; bySubagent: Breakdown[] }): {
  id: string;
  kind: 'tip' | 'efficiency' | 'pattern';
  title: string;
  detail: string;
}[] {
  const out: ReturnType<typeof advancedInsights> = [];
  const { anatomy: an, context: ce, sessions: s } = a;
  if (ce.over200kCostShare >= 0.25)
    out.push({
      id: 'long-context',
      kind: 'tip',
      title: `${Math.round(ce.over200kCostShare * 100)}% of cost comes from requests with 200k+ tokens of context`,
      detail: `${Math.round(ce.over200kShare * 100)}% of requests carry that much context. Re-reading the part above 100k cost ~$${ce.heavyContextCost.toFixed(0)} in 30 days; /compact or /clear between tasks cuts it.`,
    });
  if (an.total && an.cacheWrite1h / an.total >= 0.25)
    out.push({
      id: 'cache-writes',
      kind: 'efficiency',
      title: `Cache writes are ${Math.round(((an.cacheWrite1h + an.cacheWrite5m) / an.total) * 100)}% of cost`,
      detail: `1-hour cache writes cost 2× input. Frequent context switches (new sessions, edited CLAUDE.md, changing tools) rewrite the cache; steadier sessions write less.`,
    });
  if (ce.thinkingShareOfOutput >= 0.3)
    out.push({
      id: 'thinking',
      kind: 'pattern',
      title: `${Math.round(ce.thinkingShareOfOutput * 100)}% of output tokens are thinking`,
      detail: 'Lower effort for routine edits and searches; keep high effort for hard problems.',
    });
  if (s.oneShotCostShare >= 0.1)
    out.push({
      id: 'one-shot',
      kind: 'pattern',
      title: `${s.oneShot.toLocaleString()} one-shot sessions carry ${Math.round(s.oneShotCostShare * 100)}% of cost`,
      detail: 'Usually automations (claude -p, scripts, bots). Each starts cold without a warm cache; batching them into longer sessions saves cache writes.',
    });
  const subs = a.bySubagent.find((b) => b.key === 'subagents');
  if (subs && subs.share >= 0.3)
    out.push({
      id: 'subagents',
      kind: 'pattern',
      title: `Subagents account for ${Math.round(subs.share * 100)}% of cost`,
      detail: 'Running subagents on a cheaper model (Sonnet/Haiku) for search and reading is usually the biggest easy saving.',
    });
  return out;
}

export interface Breakdown {
  key: string;
  totals: Totals;
  share: number;
  costPerRequest: number;
}

export function breakdown(entries: Entry[], key: (e: Entry) => string, metric: Metric): Breakdown[] {
  const g = groupBy(entries, key);
  const all = [...g.values()].reduce((a, t) => a + metricOf(t, metric), 0) || 1;
  return [...g]
    .map(([k, t]) => ({ key: k, totals: t, share: metricOf(t, metric) / all, costPerRequest: t.requests ? t.cost / t.requests : 0 }))
    .sort((a, b) => b.share - a.share);
}

export interface MixPoint {
  start: number;
  label: string;
  shares: Record<string, number>;
  total: number;
}

/** Weekly share of usage by model (top 4 + other), for stacked trend charts. */
export function modelMixTrend(entries: Entry[], clock: Clock, metric: Metric, now: number, weeks = 12): { models: string[]; points: MixPoint[] } {
  let from = clock.bucketStart(now, 'week');
  for (let i = 1; i < weeks; i++) from = clock.bucketStart(from - 1, 'week');
  const win = slice(entries, from, now + 1);
  const top = breakdown(win, (e) => e.model, metric)
    .slice(0, 4)
    .map((b) => b.key);
  const points: MixPoint[] = [];
  let s = from;
  while (s < now) {
    const e = clock.nextBucket(s, 'week');
    const part = slice(entries, s, e);
    const t = new Map<string, Totals>();
    const tot = emptyTotals();
    for (const x of part) {
      const k = top.includes(x.model) ? x.model : 'other';
      let tt = t.get(k);
      if (!tt) t.set(k, (tt = emptyTotals()));
      addEntry(tt, x);
      addEntry(tot, x);
    }
    const total = metricOf(tot, metric);
    const shares: Record<string, number> = {};
    for (const [k, tt] of t) shares[k] = total ? metricOf(tt, metric) / total : 0;
    points.push({ start: s, label: clock.label(s, 'week'), shares, total });
    s = e;
  }
  return { models: [...top, 'other'], points };
}

export interface Concentration {
  topShare: number;
  top3Share: number;
  /** Herfindahl–Hirschman index over projects, 0–1 (1 = everything in one project). */
  hhi: number;
  effectiveProjects: number;
}

export function concentration(entries: Entry[], metric: Metric): Concentration {
  const b = breakdown(entries, (e) => e.project, metric);
  const hhi = b.reduce((a, x) => a + x.share * x.share, 0);
  return {
    topShare: b[0]?.share ?? 0,
    top3Share: b.slice(0, 3).reduce((a, x) => a + x.share, 0),
    hhi,
    effectiveProjects: hhi ? 1 / hhi : 0,
  };
}
