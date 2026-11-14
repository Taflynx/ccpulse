import { bucketize } from '../aggregate.js';
import { clamp, linearTrend, mean, quantile } from '../stats.js';
import { DAY, type Clock } from '../time.js';
import { metricOf, type Entry, type Metric } from '../types.js';
import type { Profile } from './baseline.js';

export interface DayPoint {
  start: number;
  label: string;
  /** Weekday index relative to week start. */
  wi: number;
  value: number;
}

export interface Prediction {
  start: number;
  label: string;
  value: number;
  lo: number;
  hi: number;
}

export interface PeriodForecast {
  label: string;
  start: number;
  end: number;
  actualSoFar: number;
  value: number;
  lo: number;
  hi: number;
  /** Same period last time, for context. */
  previous?: number;
}

export interface Forecast {
  metric: Metric;
  next7: Prediction[];
  today: PeriodForecast;
  week: PeriodForecast;
  month: PeriodForecast;
  nextMonth: PeriodForecast;
  /** Relative change per week from a linear fit on the last 8 complete weeks. */
  weeklyTrend: { slopePct: number; r2: number; weeks: number };
  /** Backtest on the last 42 days: weighted absolute percentage error (lower is better). */
  accuracy: { wape: number; days: number; coverage: number };
  /** Smoothing factor learned from this user's history. */
  alpha: number;
  model: string;
}

/**
 * Seasonal exponential smoothing on daily totals:
 * level (EWMA of de-seasonalized days) × weekday index (shrunk toward 1 when data is thin).
 * Prediction intervals come from the empirical error distribution of a rolling backtest, so they
 * reflect how predictable *this user* actually is.
 */
export function predictDay(history: DayPoint[], targetWi: number, alpha = 0.3): number {
  const recent = history.slice(-56);
  if (!recent.length) return 0;
  const overall = mean(recent.map((d) => d.value));
  if (overall <= 0) return 0;
  const idx = new Array(7).fill(1);
  for (let w = 0; w < 7; w++) {
    const vals = recent.filter((d) => d.wi === w).map((d) => d.value);
    if (!vals.length) continue;
    const raw = mean(vals) / overall;
    idx[w] = 1 + (raw - 1) * Math.min(1, vals.length / 4); // shrink toward 1 only when thin
  }
  const tail = recent.slice(-28);
  let level = tail[0].value / Math.max(idx[tail[0].wi], 0.05);
  for (let i = 1; i < tail.length; i++) level = alpha * (tail[i].value / Math.max(idx[tail[i].wi], 0.05)) + (1 - alpha) * level;
  return Math.max(0, level * idx[targetWi]);
}

export function dailySeries(entries: Entry[], clock: Clock, metric: Metric, from: number, to: number): DayPoint[] {
  return bucketize(entries, clock, 'day', from, to).map((b) => ({
    start: b.start,
    label: b.label,
    wi: clock.weekIndex(clock.parts(b.start)),
    value: metricOf(b, metric),
  }));
}

export function forecast(entries: Entry[], clock: Clock, metric: Metric, profile: Profile, now: number): Forecast {
  const todayStart = clock.bucketStart(now, 'day');
  const first = entries.length ? clock.bucketStart(entries[0].t, 'day') : todayStart;
  const histFrom = Math.max(first, todayStart - 180 * DAY);
  const complete = dailySeries(entries, clock, metric, histFrom, todayStart);
  const todayActual = dailySeries(entries, clock, metric, todayStart, now + 1)[0]?.value ?? 0;

  // Online self-tuning: on any given day, the smoothing factor is the one that best predicted
  // the 42 days before it. The model adapts to regime changes, and every backtest prediction
  // is strictly out-of-sample (the reported accuracy is honest).
  const ALPHAS = [0.1, 0.2, 0.3, 0.5, 0.7];
  const n = complete.length;
  const memo = new Map<string, number>();
  const pred = (i: number, a: number) => {
    const k = `${i}:${a}`;
    let v = memo.get(k);
    if (v === undefined) memo.set(k, (v = predictDay(complete.slice(0, i), complete[i]?.wi ?? 0, a)));
    return v;
  };
  const bestAlpha = (upTo: number) => {
    let best = 0.3;
    let bestW = Infinity;
    for (const a of ALPHAS) {
      let e = 0;
      let act = 0;
      for (let i = Math.max(14, upTo - 42); i < upTo; i++) {
        e += Math.abs(complete[i].value - pred(i, a));
        act += complete[i].value;
      }
      const w = act ? e / act : Infinity;
      if (w < bestW) [bestW, best] = [w, a];
    }
    return best;
  };
  const evalFrom = Math.max(28, n - 42);
  const alpha = bestAlpha(n);

  const ratios: number[] = [];
  let absErr = 0;
  let absAct = 0;
  let inside = 0;
  const btDays = Math.max(0, n - evalFrom);
  const preds: number[] = [];
  for (let i = evalFrom; i < n; i++) {
    const p = pred(i, bestAlpha(i));
    preds.push(p);
    const a = complete[i].value;
    absErr += Math.abs(a - p);
    absAct += a;
    if (p > 0) ratios.push(a / p);
  }
  const qlo = ratios.length >= 10 ? quantile(ratios, 0.1) : 0.4;
  const qhi = ratios.length >= 10 ? quantile(ratios, 0.9) : 2.0;
  for (let i = evalFrom; i < n; i++) {
    const p = preds[i - evalFrom];
    const a = complete[i].value;
    if (a >= p * qlo && a <= p * qhi) inside++;
  }

  const band = (v: number) => ({ value: v, lo: v * clamp(qlo, 0, 1), hi: v * Math.max(qhi, 1) });

  // Today: what is already done plus the expected rest of the day from the hourly profile.
  const todayWi = clock.weekIndex(clock.parts(now));
  const dayPred = predictDay(complete, todayWi, alpha);
  const dayProfile = profile.dayTotal(todayWi);
  const tomorrow = clock.nextBucket(todayStart, 'day');
  const restShare = dayProfile > 0 ? profile.expectedBetween(now, tomorrow) / dayProfile : (tomorrow - now) / DAY;
  const todayRest = band(dayPred * restShare);
  const today: PeriodForecast = {
    label: 'Today',
    start: todayStart,
    end: tomorrow,
    actualSoFar: todayActual,
    value: todayActual + todayRest.value,
    lo: todayActual + todayRest.lo,
    hi: todayActual + todayRest.hi,
    previous: complete.length >= 7 ? complete[complete.length - 7].value : undefined,
  };

  const next7: Prediction[] = [];
  const futurePred = new Map<number, number>();
  let d = tomorrow;
  for (let i = 0; i < 62; i++) {
    const wi = clock.weekIndex(clock.parts(d));
    const v = predictDay(complete, wi, alpha);
    futurePred.set(d, v);
    if (i < 7) next7.push({ start: d, label: clock.label(d, 'day'), ...band(v) });
    d = clock.nextBucket(d, 'day');
  }

  const period = (label: string, start: number, end: number, previous?: number): PeriodForecast => {
    let actual = 0;
    for (const p of complete) if (p.start >= start && p.start < end) actual += p.value;
    let value = 0;
    let lo = 0;
    let hi = 0;
    if (todayStart >= start && todayStart < end) {
      actual += todayActual;
      value += todayRest.value;
      lo += todayRest.lo;
      hi += todayRest.hi;
    }
    for (const [ts, v] of futurePred) {
      if (ts >= start && ts < end) {
        const b = band(v);
        value += b.value;
        lo += b.lo;
        hi += b.hi;
      }
    }
    return { label, start, end, actualSoFar: actual, value: actual + value, lo: actual + lo, hi: actual + hi, previous };
  };

  const weekStart = clock.bucketStart(now, 'week');
  const weekEnd = clock.nextBucket(weekStart, 'week');
  const monthStart = clock.bucketStart(now, 'month');
  const monthEnd = clock.nextBucket(monthStart, 'month');
  const nextMonthEnd = clock.nextBucket(monthEnd, 'month');
  const sumRange = (s: number, e: number) => complete.filter((p) => p.start >= s && p.start < e).reduce((a, p) => a + p.value, 0);
  const prevWeekStart = weekStart - 7 * DAY;
  const prevMonthStart = clock.bucketStart(monthStart - DAY, 'month');

  const weeks: number[] = [];
  for (let k = 8; k >= 1; k--) {
    const s = weekStart - k * 7 * DAY;
    if (s < first) continue;
    weeks.push(sumRange(s, s + 7 * DAY));
  }
  const lt = linearTrend(weeks);
  const wMean = mean(weeks);

  return {
    metric,
    next7,
    today,
    week: period('This week', weekStart, weekEnd, sumRange(prevWeekStart, weekStart)),
    month: period('This month', monthStart, monthEnd, sumRange(prevMonthStart, monthStart)),
    nextMonth: period('Next month', monthEnd, nextMonthEnd),
    weeklyTrend: { slopePct: wMean ? lt.slope / wMean : 0, r2: lt.r2, weeks: weeks.length },
    accuracy: { wape: absAct ? absErr / absAct : NaN, days: btDays, coverage: btDays ? inside / btDays : NaN },
    alpha,
    model: `seasonal exponential smoothing (weekday × level, online-tuned α=${alpha}), empirical 10–90% bands`,
  };
}
