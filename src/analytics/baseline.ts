import { bucketize } from '../aggregate.js';
import { HOUR, type Clock } from '../time.js';
import { metricOf, type Entry, type Metric } from '../types.js';

/**
 * A learned "typical week" for this user: the expected usage for each of the 168 hour-of-week
 * slots, as a recency-weighted mean over the last `weeks` weeks (recent weeks count more).
 */
export class Profile {
  readonly slots: number[];
  readonly weeksOfData: number;

  constructor(
    private clock: Clock,
    slots: number[],
    weeksOfData: number,
  ) {
    this.slots = slots;
    this.weeksOfData = weeksOfData;
  }

  slot(ts: number): number {
    const p = this.clock.parts(ts);
    return this.clock.weekIndex(p) * 24 + p.h;
  }

  /** Expected usage in the hour that contains `ts`. */
  expected(ts: number): number {
    return this.slots[this.slot(ts)] ?? 0;
  }

  /** Expected usage between two instants (partial hours pro-rated). */
  expectedBetween(from: number, to: number): number {
    let total = 0;
    let t = from;
    while (t < to) {
      const hourEnd = this.clock.bucketStart(t, 'hour') + HOUR;
      const end = Math.min(hourEnd, to);
      total += this.expected(t) * ((end - t) / HOUR);
      t = end;
    }
    return total;
  }

  /** Expected usage for a whole local day (by weekday index). */
  dayTotal(weekIndex: number): number {
    let s = 0;
    for (let h = 0; h < 24; h++) s += this.slots[weekIndex * 24 + h];
    return s;
  }
}

export function buildProfile(entries: Entry[], clock: Clock, metric: Metric, now: number, weeks = 8): Profile {
  const sums = new Array(168).fill(0);
  const weights = new Array(168).fill(0);
  if (!entries.length) return new Profile(clock, sums, 0);
  const end = clock.bucketStart(now, 'hour'); // complete hours only
  const start = Math.max(clock.bucketStart(entries[0].t, 'day'), end - weeks * 7 * 24 * HOUR);
  const hours = bucketize(entries, clock, 'hour', start, end);
  for (const b of hours) {
    const p = clock.parts(b.start);
    const slot = clock.weekIndex(p) * 24 + p.h;
    const ageWeeks = Math.floor((end - b.start) / (7 * 24 * HOUR));
    const w = Math.pow(0.8, ageWeeks);
    sums[slot] += metricOf(b, metric) * w;
    weights[slot] += w;
  }
  const weeksOfData = (end - start) / (7 * 24 * HOUR);
  // With under a week of history some slots were never observed: fall back to the hour-of-day mean.
  const hodSum = new Array(24).fill(0);
  const hodW = new Array(24).fill(0);
  for (let s = 0; s < 168; s++) {
    hodSum[s % 24] += sums[s];
    hodW[s % 24] += weights[s];
  }
  const slots = sums.map((v, s) => (weights[s] ? v / weights[s] : hodW[s % 24] ? hodSum[s % 24] / hodW[s % 24] : 0));
  return new Profile(clock, slots, weeksOfData);
}
