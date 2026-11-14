import { totalsOf } from '../aggregate.js';
import type { Config } from '../config.js';
import type { Snapshot } from '../history.js';
import { billingPeriod, type PlanInfo } from '../plan.js';
import { quantile } from '../stats.js';
import { DAY, type Clock } from '../time.js';
import type { Entry } from '../types.js';
import type { Forecast } from './forecast.js';

export interface PlanValue {
  period?: { start: number; end: number; day: number; days: number; elapsed: number };
  /** API-equivalent value consumed this billing period (local Claude Code logs). */
  valueSoFar: number;
  /** Projected value by period end (actual + forecast). */
  valueProjected: number;
  price?: number;
  /** value ÷ price: how many times over the plan "paid for itself" at API prices. */
  multiple?: number;
  /** Previous full periods for context. */
  history: { start: number; end: number; value: number }[];
}

export interface PlanAdvice {
  verdict: 'fits' | 'downgrade' | 'upgrade' | 'consider-api' | 'insufficient-data';
  title: string;
  detail: string;
  /** Peak weekly utilization observed over the last 4 weeks (plan meter), 0–1+. */
  peakWeekly?: number;
  /** How many of the last 4 weekly cycles reached ≥ 95%. */
  weeksAtLimit?: number;
}

export function planValue(entries: Entry[], plan: PlanInfo, cfg: Config, clock: Clock, now: number, fc: Forecast): PlanValue {
  const period = billingPeriod(plan, cfg, clock, now);
  const start = period?.start ?? clock.bucketStart(now, 'month');
  const end = period?.end ?? clock.nextBucket(start, 'month');
  const valueSoFar = totalsOf(entries, start, now + 1).cost;
  // Remaining days: today's remainder + daily predictions, converted to cost when the metric is tokens.
  let projected = valueSoFar;
  if (fc.metric === 'cost') {
    projected += fc.today.value - fc.today.actualSoFar;
    for (const p of fc.next7) if (p.start < end) projected += p.value;
    const after7 = fc.next7.length ? fc.next7[fc.next7.length - 1].start + DAY : now;
    if (after7 < end) projected += ((end - after7) / DAY) * (fc.next7.reduce((a, p) => a + p.value, 0) / Math.max(1, fc.next7.length));
  }
  const history: PlanValue['history'] = [];
  let cur = start;
  for (let k = 0; k < 3 && entries.length && cur > entries[0].t; k++) {
    const prev = billingPeriod(plan, cfg, clock, cur - 1)?.start ?? clock.bucketStart(cur - 1, 'month');
    history.push({ start: prev, end: cur, value: totalsOf(entries, prev, cur).cost });
    cur = prev;
  }
  const price = plan.monthlyPrice;
  return {
    period: period ? { start: period.start, end: period.end, day: period.day, days: period.days, elapsed: period.elapsed } : undefined,
    valueSoFar,
    valueProjected: projected,
    price,
    multiple: price ? projected / price : undefined,
    history,
  };
}

/**
 * Plan advice from real plan-meter readings: weekly peaks over the last 4 cycles. Tiers scale
 * limits roughly linearly (Max 5x ≈ ¼ of Max 20x), so a 20x user who never passes ~20% of the
 * weekly window would fit in 5x; anyone repeatedly at the wall should upgrade or enable extra usage.
 */
export function planAdvice(plan: PlanInfo, history: Snapshot[], value: PlanValue, now: number): PlanAdvice {
  if (plan.kind === 'api' || plan.kind === 'cloud') {
    const v = value.valueProjected;
    if (v >= 200)
      return {
        verdict: 'consider-api',
        title: `Pay-as-you-go spend is on track for ~$${Math.round(v)} this month`,
        detail: 'For steady individual use at this level, a Max subscription is usually cheaper than API billing. Compare against your actual invoice before switching.',
      };
    return { verdict: 'fits', title: 'Pay-as-you-go fits your volume', detail: `Projected ~$${Math.round(v)} this month.` };
  }
  const weekly = history.filter((s) => s.key === 'seven_day' && s.at >= now - 28 * DAY && s.resetsAt);
  if (weekly.length < 6)
    return {
      verdict: 'insufficient-data',
      title: 'Not enough plan-meter history yet',
      detail: 'Run ccpulse (or `ccpulse watch`) regularly for a week or two; advice is based on how close your weekly windows actually get to 100%.',
    };
  const byCycle = new Map<number, number>();
  for (const s of weekly) byCycle.set(s.resetsAt!, Math.max(byCycle.get(s.resetsAt!) ?? 0, s.utilization / 100));
  const peaks = [...byCycle.values()];
  if (peaks.length < 2)
    return {
      verdict: 'insufficient-data',
      title: 'Need at least two weekly cycles of plan-meter readings',
      detail: 'Keep ccpulse running (e.g. `ccpulse watch`); advice compares how close each weekly window gets to 100%.',
    };
  const peak = Math.max(...peaks);
  const atLimit = peaks.filter((p) => p >= 0.95).length;
  const mult = plan.multiplier;
  if (atLimit >= 2)
    return {
      verdict: 'upgrade',
      title: `You hit the weekly limit in ${atLimit} of the last ${peaks.length} weeks`,
      detail:
        plan.kind === 'pro'
          ? 'Max 5x gives ~5× the Pro allowance.'
          : mult === 5
            ? 'Max 20x gives ~4× your current weekly allowance.'
            : plan.extraUsage
              ? 'Extra usage is on, so overage is billed; watch the spend.'
              : 'Consider enabling extra usage, or shift routine work to cheaper models.',
      peakWeekly: peak,
      weeksAtLimit: atLimit,
    };
  if (mult === 20 && quantile(peaks, 0.9) < 0.2)
    return {
      verdict: 'downgrade',
      title: `Your busiest week used ${Math.round(peak * 100)}% of the Max 20x allowance`,
      detail: 'Max 5x has about a quarter of the limits. Your last 4 weeks would have fit with room to spare.',
      peakWeekly: peak,
      weeksAtLimit: atLimit,
    };
  if (mult === 5 && quantile(peaks, 0.9) < 0.15)
    return {
      verdict: 'downgrade',
      title: `Your busiest week used ${Math.round(peak * 100)}% of the Max 5x allowance`,
      detail: 'Pro has roughly a fifth of these limits. Check that it would have covered your busiest days too.',
      peakWeekly: peak,
      weeksAtLimit: atLimit,
    };
  return {
    verdict: 'fits',
    title: `Your plan fits: weekly peak ${Math.round(peak * 100)}%`,
    detail: `Over the last ${peaks.length} weekly cycles you never ran out, and you use enough of it to justify the tier.`,
    peakWeekly: peak,
    weeksAtLimit: atLimit,
  };
}
