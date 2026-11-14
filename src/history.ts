import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { lowerBound } from './aggregate.js';
import { windowLength, type OfficialUsage } from './limits.js';
import { dirs } from './paths.js';
import { median, quantile } from './stats.js';
import type { Entry } from './types.js';

/**
 * Learning loop: each time real utilization is known, record how much local usage (cost)
 * produced it. Over time this calibrates "how many API-equivalent dollars is 100% of my plan",
 * which keeps pace and forecasts working offline and for windows the endpoint does not report.
 */
export interface Snapshot {
  at: number;
  key: string;
  utilization: number;
  resetsAt?: number;
  localCost: number;
  localTokens: number;
}

function file(): string {
  return path.join(dirs.state(), 'limit-history.jsonl');
}

export function readHistory(): Snapshot[] {
  const f = file();
  if (!existsSync(f)) return [];
  const out: Snapshot[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

function windowSums(entries: Entry[], from: number, to: number): { cost: number; tokens: number } {
  let cost = 0;
  let tokens = 0;
  for (let i = lowerBound(entries, from); i < entries.length && entries[i].t < to; i++) {
    const e = entries[i];
    cost += e.cost;
    tokens += e.input + e.output + e.cacheWrite5m + e.cacheWrite1h + e.cacheRead;
  }
  return { cost, tokens };
}

/** Record at most one snapshot per window every 10 minutes. */
export function recordSnapshot(usage: OfficialUsage, entries: Entry[], history = readHistory()): Snapshot[] {
  const added: Snapshot[] = [];
  for (const w of usage.windows) {
    const len = windowLength(w.key);
    if (!len || !w.resetsAt) continue;
    const last = [...history].reverse().find((s) => s.key === w.key);
    if (last && usage.fetchedAt - last.at < 10 * 60_000) continue;
    const { cost, tokens } = windowSums(entries, w.resetsAt - len, usage.fetchedAt);
    added.push({ at: usage.fetchedAt, key: w.key, utilization: w.utilization, resetsAt: w.resetsAt, localCost: cost, localTokens: tokens });
  }
  if (added.length) {
    mkdirSync(path.dirname(file()), { recursive: true });
    appendFileSync(file(), added.map((s) => JSON.stringify(s)).join('\n') + '\n');
  }
  return added;
}

export interface Calibration {
  key: string;
  /** Estimated API-equivalent cost that equals 100% of this window. */
  limitCost: number;
  /** Interquartile spread relative to the estimate (lower = more trustworthy). */
  spread: number;
  samples: number;
  /** Last known reset time, used to anchor the window offline. */
  lastResetsAt?: number;
}

export function calibrate(history: Snapshot[]): Map<string, Calibration> {
  const byKey = new Map<string, Snapshot[]>();
  for (const s of history) {
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key)!.push(s);
  }
  const out = new Map<string, Calibration>();
  for (const [key, snaps] of byKey) {
    // Low utilization readings are rounded and noisy; use the most recent informative ones.
    const useful = snaps.filter((s) => s.utilization >= 8 && s.localCost > 0).slice(-40);
    const lastResetsAt = snaps.filter((s) => s.resetsAt).slice(-1)[0]?.resetsAt;
    if (useful.length < 2) {
      if (lastResetsAt) out.set(key, { key, limitCost: NaN, spread: NaN, samples: useful.length, lastResetsAt });
      continue;
    }
    const est = useful.map((s) => s.localCost / (s.utilization / 100));
    const m = median(est);
    out.set(key, {
      key,
      limitCost: m,
      spread: m ? (quantile(est, 0.75) - quantile(est, 0.25)) / m : NaN,
      samples: useful.length,
      lastResetsAt,
    });
  }
  return out;
}
