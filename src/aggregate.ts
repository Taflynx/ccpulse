import type { Clock } from './time.js';
import { addEntry, emptyTotals, type Bucket, type Entry, type Granularity, type Totals } from './types.js';

/** Group entries into contiguous buckets (empty ones included) from `from` to `to`. */
export function bucketize(entries: Entry[], clock: Clock, g: Granularity, from: number, to: number): Bucket[] {
  const map = new Map<number, Totals>();
  for (const e of entries) {
    if (e.t < from || e.t >= to) continue;
    const s = clock.bucketStart(e.t, g);
    let b = map.get(s);
    if (!b) map.set(s, (b = emptyTotals()));
    addEntry(b, e);
  }
  const out: Bucket[] = [];
  let s = clock.bucketStart(from, g);
  let guard = 0;
  while (s < to && guard++ < 100_000) {
    out.push({ start: s, label: clock.label(s, g), ...(map.get(s) ?? emptyTotals()) });
    s = clock.nextBucket(s, g);
  }
  return out;
}

export function totalsOf(entries: Entry[], from = -Infinity, to = Infinity): Totals {
  const t = emptyTotals();
  for (const e of entries) if (e.t >= from && e.t < to) addEntry(t, e);
  return t;
}

export function groupBy(entries: Entry[], key: (e: Entry) => string, from = -Infinity, to = Infinity): Map<string, Totals> {
  const m = new Map<string, Totals>();
  for (const e of entries) {
    if (e.t < from || e.t >= to) continue;
    const k = key(e);
    let t = m.get(k);
    if (!t) m.set(k, (t = emptyTotals()));
    addEntry(t, e);
  }
  return m;
}

/** Binary search: first index with t >= ts (entries are sorted by time). */
export function lowerBound(entries: Entry[], ts: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].t < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function slice(entries: Entry[], from: number, to: number): Entry[] {
  return entries.slice(lowerBound(entries, from), lowerBound(entries, to));
}
