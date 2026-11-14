import type { Granularity } from './types.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface LocalParts {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  /** 0 = Monday … 6 = Sunday */
  dow: number;
}

/** Time-zone aware calendar math using only Intl (no dependencies). */
export class Clock {
  readonly tz: string;
  readonly weekStartsSunday: boolean;
  private fmt: Intl.DateTimeFormat;
  private cache = new Map<number, LocalParts>();

  constructor(tz?: string, weekStart: 'monday' | 'sunday' = 'monday') {
    this.tz = tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this.weekStartsSunday = weekStart === 'sunday';
    this.fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: this.tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
  }

  parts(ts: number): LocalParts {
    // Offsets change on 15-minute boundaries at most; cache per quarter hour.
    const q = Math.floor(ts / 900_000);
    let p = this.cache.get(q);
    if (!p) {
      const o: Record<string, string> = {};
      for (const x of this.fmt.formatToParts(new Date(q * 900_000))) o[x.type] = x.value;
      const dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      p = { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, dow: dows.indexOf(o.weekday) };
      if (this.cache.size > 200_000) this.cache.clear();
      this.cache.set(q, p);
    }
    const extraMin = Math.floor((ts - q * 900_000) / 60_000);
    return extraMin ? { ...p, mi: p.mi + extraMin } : p;
  }

  /** Local wall-clock → epoch ms (handles DST by iterating on the offset). */
  toEpoch(y: number, mo: number, d: number, h = 0, mi = 0): number {
    const wall = Date.UTC(y, mo - 1, d, h, mi);
    let ts = wall;
    for (let i = 0; i < 3; i++) {
      const p = this.parts(ts);
      const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
      const off = asUtc - ts;
      const nextTs = wall - off;
      if (nextTs === ts) break;
      ts = nextTs;
    }
    return ts;
  }

  /** Weekday index relative to the configured week start (0 = first day of week). */
  weekIndex(p: LocalParts): number {
    return this.weekStartsSunday ? (p.dow + 1) % 7 : p.dow;
  }

  bucketStart(ts: number, g: Granularity): number {
    const p = this.parts(ts);
    switch (g) {
      case 'hour':
        // Offset-agnostic: strip local minutes. Correct across DST repeats and :30/:45 zones.
        return Math.floor(ts / 60_000) * 60_000 - p.mi * 60_000;
      case 'day':
        return this.toEpoch(p.y, p.mo, p.d);
      case 'week': {
        const back = this.weekIndex(p);
        const day = new Date(Date.UTC(p.y, p.mo - 1, p.d - back));
        return this.toEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
      }
      case 'month':
        return this.toEpoch(p.y, p.mo, 1);
    }
  }

  nextBucket(start: number, g: Granularity): number {
    const n = this.nextBucketRaw(start, g);
    // Never step backwards or stall (DST edge cases).
    return n > start ? n : this.bucketStart(start + (g === 'hour' ? HOUR : DAY) + 60_000, g === 'hour' ? 'hour' : g);
  }

  private nextBucketRaw(start: number, g: Granularity): number {
    const p = this.parts(start);
    switch (g) {
      case 'hour':
        return start + HOUR;
      case 'day': {
        const n = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
        return this.toEpoch(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
      }
      case 'week': {
        const n = new Date(Date.UTC(p.y, p.mo - 1, p.d + 7));
        return this.toEpoch(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
      }
      case 'month': {
        const n = new Date(Date.UTC(p.y, p.mo, 1));
        return this.toEpoch(n.getUTCFullYear(), n.getUTCMonth() + 1, 1);
      }
    }
  }

  label(start: number, g: Granularity): string {
    const p = this.parts(start);
    const d = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
    switch (g) {
      case 'hour':
        return `${d} ${pad(p.h)}:00`;
      case 'day':
        return `${d} ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][p.dow]}`;
      case 'week':
        return `wk of ${d}`;
      case 'month':
        return `${p.y}-${pad(p.mo)}`;
    }
  }

  /** "Thu 18:00" style label. */
  short(ts: number): string {
    const p = this.parts(ts);
    return `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][p.dow]} ${pad(p.h)}:${pad(p.mi)}`;
  }

  dateTime(ts: number): string {
    const p = this.parts(ts);
    return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
  }
}

export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 90 → "1h 30m", 2.5 days → "2d 12h". */
export function duration(ms: number): string {
  const neg = ms < 0;
  let m = Math.round(Math.abs(ms) / 60_000);
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  const s = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  return neg ? `-${s}` : s;
}
