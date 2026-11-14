import { bucketize, groupBy, slice } from '../aggregate.js';
import { quantile, median } from '../stats.js';
import { DAY, HOUR, duration, type Clock } from '../time.js';
import { metricOf, type Entry, type Metric } from '../types.js';

export interface Anomaly {
  id: string;
  kind: 'hour' | 'day' | 'session';
  start: number;
  end: number;
  label: string;
  value: number;
  /** Typical value for comparison (median of the baseline). */
  typical: number;
  /** How many "typical spreads" above normal. */
  score: number;
  /** value / typical upper range (p90). */
  ratio: number;
  severity: 'notice' | 'high' | 'extreme';
  drivers: { model?: string; project?: string; session?: string; share: number }[];
  explanation: string;
}

export interface AnomalyOptions {
  metric: Metric;
  z: number;
  min: number;
  now: number;
  /** How far back to look for anomalies. */
  lookbackDays?: number;
}

/**
 * Robust spike detection. The scale is the p50→p90 spread of the user's own history for that
 * hour-of-day (or day), floored so quiet baselines do not flag trivial usage. Usage is bursty and
 * zero-heavy, so standard deviations would over-alert; quantiles do not.
 */
function score(x: number, samples: number[], floor: number): { score: number; typical: number; p90: number } {
  const p50 = median(samples);
  const p90 = quantile(samples, 0.9);
  const scale = Math.max(p90 - p50, floor);
  return { score: (x - p50) / scale, typical: p50, p90 };
}

function severity(s: number, z: number): Anomaly['severity'] {
  return s >= z * 3 ? 'extreme' : s >= z * 1.75 ? 'high' : 'notice';
}

function drivers(entries: Entry[], metric: Metric): Anomaly['drivers'] {
  const total = entries.reduce((a, e) => a + (metric === 'cost' ? e.cost : e.input + e.output + e.cacheRead + e.cacheWrite1h + e.cacheWrite5m), 0) || 1;
  const pick = (key: (e: Entry) => string) => {
    const g = [...groupBy(entries, key)].map(([k, t]) => [k, metricOf(t, metric)] as const).sort((a, b) => b[1] - a[1]);
    return g[0] ? { k: g[0][0], share: g[0][1] / total } : undefined;
  };
  const out: Anomaly['drivers'] = [];
  const p = pick((e) => e.project);
  const m = pick((e) => e.model);
  const s = pick((e) => e.sessionId);
  if (p) out.push({ project: p.k, share: p.share });
  if (m) out.push({ model: m.k, share: m.share });
  if (s) out.push({ session: s.k, share: s.share });
  return out;
}

function fmt(v: number, metric: Metric): string {
  return metric === 'cost' ? `$${v.toFixed(2)}` : `${(v / 1e6).toFixed(1)}M tok`;
}

export function detectAnomalies(entries: Entry[], clock: Clock, o: AnomalyOptions): Anomaly[] {
  const out: Anomaly[] = [];
  const lookback = (o.lookbackDays ?? 2) * DAY;
  const hourNow = clock.bucketStart(o.now, 'hour');
  const histFrom = hourNow - lookback - 28 * DAY;
  const hours = bucketize(entries, clock, 'hour', Math.max(histFrom, entries[0]?.t ?? histFrom), o.now + 1);
  const minFloor = o.metric === 'cost' ? o.min : o.min * 1e6;

  // Hourly: compare to the same hour-of-day over the previous 28 days.
  for (let i = 0; i < hours.length; i++) {
    const b = hours[i];
    if (b.start < hourNow - lookback) continue;
    const v = metricOf(b, o.metric);
    if (v < minFloor) continue;
    const h = clock.parts(b.start).h;
    const samples = hours.filter((x) => x.start < b.start && x.start >= b.start - 28 * DAY && clock.parts(x.start).h === h).map((x) => metricOf(x, o.metric));
    if (samples.length < 7) continue;
    const s = score(v, samples, minFloor);
    if (s.score < o.z) continue;
    const es = slice(entries, b.start, b.start + HOUR);
    const dr = drivers(es, o.metric);
    out.push({
      id: `hour:${b.start}`,
      kind: 'hour',
      start: b.start,
      end: b.start + HOUR,
      label: b.label,
      value: v,
      typical: s.typical,
      score: s.score,
      ratio: s.p90 > 0 ? v / s.p90 : Infinity,
      severity: severity(s.score, o.z),
      drivers: dr,
      explanation: `${fmt(v, o.metric)} in one hour vs. a typical ${fmt(s.typical, o.metric)} (busy hours ≈ ${fmt(s.p90, o.metric)}) at this time of day${
        dr[0]?.project ? `; ${Math.round(dr[0].share * 100)}% from ${dr[0].project}` : ''
      }.`,
    });
  }

  // Daily: last 14 days vs. the prior 56.
  const dayNow = clock.bucketStart(o.now, 'day');
  const days = bucketize(entries, clock, 'day', Math.max(dayNow - 70 * DAY, entries[0]?.t ?? dayNow), o.now + 1);
  for (const b of days) {
    if (b.start < dayNow - 14 * DAY) continue;
    const v = metricOf(b, o.metric);
    const samples = days.filter((x) => x.start < b.start && x.start >= b.start - 56 * DAY).map((x) => metricOf(x, o.metric));
    if (samples.length < 14) continue;
    const s = score(v, samples, minFloor * 5);
    if (s.score < o.z * 0.75 || v < minFloor * 5) continue;
    const dr = drivers(slice(entries, b.start, clock.nextBucket(b.start, 'day')), o.metric);
    out.push({
      id: `day:${b.start}`,
      kind: 'day',
      start: b.start,
      end: clock.nextBucket(b.start, 'day'),
      label: b.label,
      value: v,
      typical: s.typical,
      score: s.score,
      ratio: s.p90 > 0 ? v / s.p90 : Infinity,
      severity: severity(s.score, o.z * 0.75),
      drivers: dr,
      explanation: `${fmt(v, o.metric)} for the day vs. a typical ${fmt(s.typical, o.metric)}${b.start === dayNow ? ' (so far)' : ''}${
        dr[0]?.project ? `; led by ${dr[0].project}` : ''
      }.`,
    });
  }

  // Session runs: a session split wherever it was idle for 2h+, so long-lived or resumed
  // sessions (bots, `--resume`) are judged per burst of work. Last `lookback` vs. last 90 days.
  const sessFrom = o.now - 90 * DAY;
  const recent = slice(entries, sessFrom, o.now + 1);
  const sessions = new Map<string, { v: number; start: number; end: number; project: string; models: Map<string, number> }>();
  const openRun = new Map<string, string>();
  for (const e of recent) {
    const runId = openRun.get(e.sessionId);
    let s = runId ? sessions.get(runId) : undefined;
    if (!s || e.t - s.end > 2 * HOUR) {
      const id = `${e.sessionId}@${e.t}`;
      openRun.set(e.sessionId, id);
      sessions.set(id, (s = { v: 0, start: e.t, end: e.t, project: e.project, models: new Map() }));
    }
    const add = o.metric === 'cost' ? e.cost : e.input + e.output + e.cacheRead + e.cacheWrite1h + e.cacheWrite5m;
    s.v += add;
    s.end = e.t;
    s.models.set(e.model, (s.models.get(e.model) ?? 0) + add);
  }
  // Judge each run against runs of the same project (falls back to all runs), so one heavy
  // project does not hide behind thousands of tiny automated sessions, and vice versa.
  const all = [...sessions.values()].map((s) => s.v);
  const byProject = new Map<string, number[]>();
  for (const s of sessions.values()) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project)!.push(s.v);
  }
  if (all.length >= 20) {
    const p99All = quantile(all, 0.99);
    const found: Anomaly[] = [];
    for (const [id, s] of sessions) {
      if (s.end < o.now - lookback) continue;
      const own = byProject.get(s.project)!;
      const base = own.length >= 10 ? own : all;
      const p50 = median(base);
      const p90 = quantile(base, 0.9);
      if (s.v < Math.max(p90 * 4, p99All) || s.v < minFloor * 10) continue;
      const topModel = [...s.models].sort((a, b) => b[1] - a[1])[0];
      const sc = (s.v - p50) / Math.max(p90 - p50, minFloor);
      const r = p90 > 0 ? s.v / p90 : Infinity;
      found.push({
        id: `session:${id}`,
        kind: 'session',
        start: s.start,
        end: s.end,
        label: `${s.project} · ${clock.dateTime(s.start)}`,
        value: s.v,
        typical: p50,
        score: sc,
        ratio: r,
        severity: r >= 15 ? 'extreme' : r >= 8 ? 'high' : 'notice',
        drivers: [{ project: s.project, share: 1 }, { model: topModel?.[0], share: topModel ? topModel[1] / s.v : 0 }, { session: id.split('@')[0], share: 1 }],
        explanation: `One working session used ${fmt(s.v, o.metric)} over ${duration(s.end - s.start)}, ${r.toFixed(1)}× a busy ${
          own.length >= 10 ? s.project : ''
        } session (typical ${fmt(p50, o.metric)}).`.replace('a busy  session', 'a busy session'),
      });
    }
    // Keep the most unusual few; a long list stops being a signal.
    out.push(...found.sort((a, b) => b.ratio - a.ratio).slice(0, 8));
  }
  // Inside a day that is already flagged, keep only its two strongest hours.
  const dayIds = new Set(out.filter((x) => x.kind === 'day').map((x) => x.start));
  const perDay = new Map<number, Anomaly[]>();
  for (const x of out) {
    if (x.kind !== 'hour') continue;
    const d = clock.bucketStart(x.start, 'day');
    if (!dayIds.has(d)) continue;
    if (!perDay.has(d)) perDay.set(d, []);
    perDay.get(d)!.push(x);
  }
  const drop = new Set<Anomaly>();
  for (const list of perDay.values()) for (const x of list.sort((a, b) => b.score - a.score).slice(2)) drop.add(x);
  return out.filter((x) => !drop.has(x)).sort((a, b) => b.start - a.start);
}
