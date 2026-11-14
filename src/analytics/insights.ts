import { bucketize, groupBy, slice, totalsOf } from '../aggregate.js';
import { costOf, priceFor } from '../pricing.js';
import { pctChange } from '../stats.js';
import { DAY, pad, type Clock } from '../time.js';
import { metricOf, type Entry, type Metric } from '../types.js';
import type { Forecast } from './forecast.js';
import type { CycleStatus } from './cycle.js';

export interface Insight {
  id: string;
  kind: 'pattern' | 'trend' | 'efficiency' | 'tip' | 'warning';
  title: string;
  detail: string;
  /** Optional numbers for UIs. */
  data?: Record<string, unknown>;
}

export interface Habits {
  /** Average metric per hour-of-day (0–23), last 28 days. */
  hourOfDay: number[];
  /** Average metric per weekday index (week-start relative), last 8 weeks. */
  weekday: number[];
  /** 7×24 grid of averages, last 8 weeks. */
  heatmap: number[][];
  activeHoursPerDay: number;
  cacheHitRate: number;
  /** What caching saved, API-equivalent USD, last 28 days. */
  cacheSavings: number;
  outputShare: number;
  costPerSession: number;
  sessionsPerDay: number;
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function money(v: number): string {
  return v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

function pct(v: number): string {
  return `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
}

export function habits(entries: Entry[], clock: Clock, metric: Metric, now: number): Habits {
  const from = now - 56 * DAY;
  const hours = bucketize(entries, clock, 'hour', Math.max(from, entries[0]?.t ?? from), now);
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const cnt = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const hod = new Array(24).fill(0);
  const hodN = new Array(24).fill(0);
  let activeHours = 0;
  for (const b of hours) {
    const p = clock.parts(b.start);
    const wi = clock.weekIndex(p);
    const v = metricOf(b, metric);
    grid[wi][p.h] += v;
    cnt[wi][p.h] += 1;
    if (b.start >= now - 28 * DAY) {
      hod[p.h] += v;
      hodN[p.h] += 1;
      if (b.requests > 0) activeHours++;
    }
  }
  const heatmap = grid.map((row, w) => row.map((v, h) => (cnt[w][h] ? v / cnt[w][h] : 0)));
  const weekday = heatmap.map((row) => row.reduce((a, b) => a + b, 0));
  const last28 = slice(entries, now - 28 * DAY, now + 1);
  const t = totalsOf(last28);
  const promptTokens = t.input + t.cacheRead + t.cacheWrite;
  let savings = 0;
  for (const e of last28) {
    const p = priceFor(e.model, e.speed);
    if (p) savings += (e.cacheRead * (p.input - p.cacheRead)) / 1e6;
  }
  const sessions = new Set(last28.map((e) => e.sessionId)).size;
  const days = Math.max(1, Math.min(28, (now - (entries[0]?.t ?? now)) / DAY));
  return {
    hourOfDay: hod.map((v, h) => (hodN[h] ? v / hodN[h] : 0)),
    weekday,
    heatmap,
    activeHoursPerDay: activeHours / days,
    cacheHitRate: promptTokens ? t.cacheRead / promptTokens : 0,
    cacheSavings: savings,
    outputShare: t.tokens ? t.output / t.tokens : 0,
    costPerSession: sessions ? t.cost / sessions : 0,
    sessionsPerDay: sessions / days,
  };
}

/** Cheapest sibling in the same generation for "what if" estimates. */
function cheaperSibling(model: string): string | undefined {
  const m = model.match(/^claude-(opus|fable)-(\d+(?:\.\d+)?)/);
  if (!m) return undefined;
  for (const cand of [`claude-sonnet-${m[2]}`, 'claude-sonnet-5.5', 'claude-sonnet-5']) if (priceFor(cand)) return cand;
  return undefined;
}

export function insights(
  entries: Entry[],
  clock: Clock,
  metric: Metric,
  now: number,
  h: Habits,
  fc?: Forecast,
  cycles: CycleStatus[] = [],
): Insight[] {
  const out: Insight[] = [];
  if (!entries.length) return out;
  const fmt = (v: number) => (metric === 'cost' ? money(v) : `${(v / 1e6).toFixed(1)}M tokens`);

  // Peak hours
  const top = h.hourOfDay
    .map((v, hr) => [hr, v] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .filter((x) => x[1] > 0);
  if (top.length) {
    const totalDay = h.hourOfDay.reduce((a, b) => a + b, 0) || 1;
    const share = top.reduce((a, x) => a + x[1], 0) / totalDay;
    out.push({
      id: 'peak-hours',
      kind: 'pattern',
      title: `Your peak hours: ${top.map(([hr]) => `${pad(hr)}:00`).join(', ')}`,
      detail: `These 3 hours carry ${Math.round(share * 100)}% of a typical day's usage. Schedule heavy agent runs outside them to spread load across your limits.`,
      data: { hours: top.map((x) => x[0]), share },
    });
  }

  // Busiest weekday
  const wd = h.weekday.map((v, i) => [i, v] as const).sort((a, b) => b[1] - a[1]);
  if (wd[0] && wd[0][1] > 0) {
    const avg = h.weekday.reduce((a, b) => a + b, 0) / 7;
    const label = (i: number) => DOW[clock.weekStartsSunday ? (i + 6) % 7 : i];
    out.push({
      id: 'busiest-day',
      kind: 'pattern',
      title: `${label(wd[0][0])} is your heaviest day`,
      detail: `${fmt(wd[0][1])} on a typical ${label(wd[0][0])} (${avg ? `${(wd[0][1] / avg).toFixed(1)}×` : '-'} the daily average); lightest is ${label(wd[6][0])}.`,
    });
  }

  // Week-over-week and month-over-month
  const weekStart = clock.bucketStart(now, 'week');
  const elapsedInWeek = now - weekStart;
  const thisWeek = metricOf(totalsOf(entries, weekStart, now), metric);
  const lastWeekSamePoint = metricOf(totalsOf(entries, weekStart - 7 * DAY, weekStart - 7 * DAY + elapsedInWeek), metric);
  const wow = pctChange(thisWeek, lastWeekSamePoint);
  if (wow !== undefined && Math.abs(wow) >= 0.15) {
    out.push({
      id: 'wow',
      kind: 'trend',
      title: `${wow > 0 ? 'Up' : 'Down'} ${pct(wow)} vs. this point last week`,
      detail: `${fmt(thisWeek)} so far this week vs. ${fmt(lastWeekSamePoint)} at the same point last week.`,
      data: { wow },
    });
  }
  if (fc && fc.weeklyTrend.weeks >= 4 && Math.abs(fc.weeklyTrend.slopePct) >= 0.05 && fc.weeklyTrend.r2 >= 0.3) {
    out.push({
      id: 'trend',
      kind: 'trend',
      title: `Usage is ${fc.weeklyTrend.slopePct > 0 ? 'growing' : 'shrinking'} ~${Math.round(Math.abs(fc.weeklyTrend.slopePct) * 100)}% per week`,
      detail: `Linear fit over the last ${fc.weeklyTrend.weeks} weeks (R² ${fc.weeklyTrend.r2.toFixed(2)}).`,
    });
  }

  // Model mix shift
  const mixNow = groupBy(entries, (e) => e.model, now - 7 * DAY, now);
  const mixPrev = groupBy(entries, (e) => e.model, now - 14 * DAY, now - 7 * DAY);
  const totNow = [...mixNow.values()].reduce((a, t) => a + t.cost, 0);
  const totPrev = [...mixPrev.values()].reduce((a, t) => a + t.cost, 0);
  if (totNow > 0) {
    const ranked = [...mixNow].sort((a, b) => b[1].cost - a[1].cost);
    const [topModel, topT] = ranked[0];
    const shareNow = topT.cost / totNow;
    const sharePrev = totPrev ? (mixPrev.get(topModel)?.cost ?? 0) / totPrev : undefined;
    out.push({
      id: 'model-mix',
      kind: 'pattern',
      title: `${topModel} drives ${Math.round(shareNow * 100)}% of your usage weight`,
      detail:
        `Last 7 days, by API-equivalent cost.` +
        (sharePrev !== undefined ? ` Previous week: ${Math.round(sharePrev * 100)}%.` : '') +
        ` Expensive models use plan limits faster for the same tokens.`,
      data: { mix: ranked.map(([m, t]) => ({ model: m, share: t.cost / totNow })) },
    });
    const sib = cheaperSibling(topModel);
    if (sib && shareNow >= 0.4) {
      const es = slice(entries, now - 7 * DAY, now).filter((e) => e.model === topModel);
      const alt = es.reduce((a, e) => a + costOf(sib, e, undefined), 0);
      const save = topT.cost - alt;
      if (save > 0 && save / totNow >= 0.1)
        out.push({
          id: 'what-if-model',
          kind: 'tip',
          title: `What if: routine work on ${sib}`,
          detail: `Running last week's ${topModel} traffic on ${sib} would have weighed ${money(alt)} instead of ${money(topT.cost)} (−${Math.round(
            (save / totNow) * 100,
          )}% of your week). Even moving a quarter of it (subagents, search, simple edits) buys real headroom.`,
        });
    }
  }

  // Cache efficiency
  if (h.cacheHitRate > 0) {
    out.push({
      id: 'cache',
      kind: 'efficiency',
      title: `Prompt cache hit rate: ${Math.round(h.cacheHitRate * 100)}%`,
      detail: `Caching saved about ${money(h.cacheSavings)} (API-equivalent) over 28 days.${
        h.cacheHitRate < 0.7 ? ' Below 70% often means many short sessions or frequent /clear; longer sessions reuse context more cheaply.' : ''
      }`,
    });
  }

  // Sessions
  if (h.sessionsPerDay > 0) {
    out.push({
      id: 'sessions',
      kind: 'pattern',
      title: `${h.sessionsPerDay.toFixed(1)} sessions/day, ${money(h.costPerSession)} each on average`,
      detail: `Active ${h.activeHoursPerDay.toFixed(1)} hours per day (last 28 days). Output tokens are ${(h.outputShare * 100).toFixed(1)}% of all tokens; the rest is context.`,
    });
  }

  // Projects
  const pNow = groupBy(entries, (e) => e.project, now - 7 * DAY, now);
  const pPrev = groupBy(entries, (e) => e.project, now - 14 * DAY, now - 7 * DAY);
  const movers = [...pNow]
    .map(([p, t]) => ({ p, now: metricOf(t, metric), prev: metricOf(pPrev.get(p) ?? { cost: 0, tokens: 0 } as any, metric) }))
    .sort((a, b) => b.now - b.prev - (a.now - a.prev));
  const m = movers[0];
  if (m && m.now - m.prev > 0 && (m.prev === 0 || m.now / m.prev >= 1.5)) {
    out.push({
      id: 'project-mover',
      kind: 'trend',
      title: `Biggest riser: ${m.p}`,
      detail: `${fmt(m.now)} this week vs. ${fmt(m.prev)} the week before.`,
    });
  }

  // Cycle-driven warnings
  for (const c of cycles) {
    if (c.status === 'critical' && c.source !== 'history' && c.etaFull && c.etaFull < c.end) {
      out.unshift({
        id: `cycle-${c.key}`,
        kind: 'warning',
        title: `${c.label}: on track to hit the limit ${clock.short(c.etaFull)}`,
        detail: `That is ${durationText(c.end - c.etaFull)} before it resets (${clock.short(c.end)}). To land at 100% exactly, keep under ${money(c.safeBurnPerHour ?? 0)}/h.`,
      });
    }
  }
  return out;
}

function durationText(ms: number): string {
  const h = ms / 3_600_000;
  return h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} h`;
}
