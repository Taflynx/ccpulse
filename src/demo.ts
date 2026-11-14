import { totalsOf } from './aggregate.js';
import { parseWeeklyAnchor, sessionBlocks } from './analytics/cycle.js';
import type { Snapshot } from './history.js';
import type { OfficialUsage } from './limits.js';
import { costOf } from './pricing.js';
import { Clock, DAY, HOUR } from './time.js';
import type { Entry } from './types.js';

/**
 * Deterministic synthetic usage for `--demo`: a developer with weekday work hours,
 * lighter evenings and weekends, a gentle growth trend, a heavier current week and a couple
 * of genuine spikes. Lets anyone try every view without real logs (and keeps screenshots private).
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTS: [string, number][] = [
  ['web-app', 0.32],
  ['api-gateway', 0.24],
  ['data-pipeline', 0.16],
  ['infra', 0.12],
  ['mobile', 0.1],
  ['docs-site', 0.06],
];
const MODELS: [string, number][] = [
  ['claude-opus-5.5', 0.55],
  ['claude-sonnet-5.5', 0.36],
  ['claude-haiku-5.5', 0.09],
];
const HOUR_SHAPE = [0.02, 0.01, 0, 0, 0, 0, 0.03, 0.12, 0.55, 0.95, 1, 0.85, 0.45, 0.6, 0.9, 1, 0.92, 0.7, 0.35, 0.25, 0.45, 0.5, 0.3, 0.08];
const WEEKDAY = [1, 1.05, 1.1, 1, 0.85, 0.22, 0.3]; // Mon..Sun

function pick<T>(r: number, items: [T, number][]): T {
  let acc = 0;
  for (const [v, w] of items) {
    acc += w;
    if (r < acc) return v;
  }
  return items[items.length - 1][0];
}

export interface Demo {
  entries: Entry[];
  official: OfficialUsage;
  history: Snapshot[];
}

export function demoData(now = Date.now(), tz?: string): Demo {
  const clock = new Clock(tz);
  const r = rng(20261114);
  const entries: Entry[] = [];
  const start = clock.bucketStart(now - 120 * DAY, 'day');
  const weekStart = clock.bucketStart(now, 'week');
  const spikeDay = clock.bucketStart(now - 2 * DAY, 'day');
  const sessionOf = new Map<string, { id: string; last: number }>();
  for (let h = start; h < now; h += HOUR) {
    const p = clock.parts(h);
    const weeksAgo = (now - h) / (7 * DAY);
    let intensity = HOUR_SHAPE[p.h] * WEEKDAY[p.dow] * (1 - weeksAgo * 0.025);
    if (h >= weekStart) intensity *= 1.35; // a heavier week, to show pace warnings
    if (h >= now - 3 * HOUR) intensity = Math.max(intensity, 1.5); // an active session right now
    if (h >= spikeDay + 19 * HOUR && h < spikeDay + 22 * HOUR) intensity = 4.2; // runaway agent loop
    if (r() < 0.12) intensity *= 0.1; // meetings, breaks
    intensity *= Math.exp((r() - 0.5) * 0.9);
    const n = Math.round(intensity * 110);
    const project = pick(r(), PROJECTS);
    for (let i = 0; i < n; i++) {
      const t = h + Math.floor(r() * HOUR);
      if (t >= now) continue;
      const proj = r() < 0.75 ? project : pick(r(), PROJECTS);
      const model = h >= spikeDay + 19 * HOUR && h < spikeDay + 22 * HOUR ? 'claude-opus-5.5' : pick(r(), MODELS);
      let s = sessionOf.get(proj);
      if (!s || t - s.last > 2 * HOUR || r() < 0.004) sessionOf.set(proj, (s = { id: `demo-${proj}-${t}`, last: t }));
      s.last = Math.max(s.last, t);
      const u = {
        input: 5 + Math.floor(r() * 40),
        output: 150 + Math.floor(r() * 900),
        cacheWrite5m: 0,
        cacheWrite1h: Math.floor(r() * r() * 9000),
        cacheRead: 20_000 + Math.floor(r() * 110_000),
      };
      entries.push({ t, model, project: proj, sessionId: s.id, ...u, cost: costOf(model, u) });
    }
  }
  entries.sort((a, b) => a.t - b.t);

  // A plan meter that agrees with the synthetic logs: limits sit a bit above a typical
  // week / a heavy session, so the heavier current week shows a pace warning.
  let reset = parseWeeklyAnchor('thu 18:00', clock, now)! + 7 * DAY;
  const weekFrom = reset - 7 * DAY;
  const weekCost = totalsOf(entries, weekFrom, now + 1).cost * 1.04;
  const blocks = sessionBlocks(entries, clock, now - DAY);
  const active = blocks.length && blocks[blocks.length - 1].end > now ? blocks[blocks.length - 1] : undefined;
  // Tell a clear story: the week runs ~1.35x ahead of even pace, the session ~1.1x, Opus on pace.
  const weekElapsed = Math.max(0.05, (now - weekFrom) / (7 * DAY));
  const weeklyLimit = weekCost / Math.min(0.92, weekElapsed * 1.35);
  const sessElapsed = active ? Math.max(0.05, (now - active.start) / (5 * HOUR)) : 0.5;
  const sessionLimit = Math.max(1, (active?.cost ?? 1) / Math.min(0.9, sessElapsed * 1.1));
  const official: OfficialUsage = {
    fetchedAt: now,
    windows: [
      { key: 'five_hour', utilization: Math.min(100, Math.round(((active?.cost ?? 0) / sessionLimit) * 100)), resetsAt: active?.end ?? now + 5 * HOUR },
      { key: 'seven_day', utilization: Math.min(100, Math.round((weekCost / weeklyLimit) * 100)), resetsAt: reset },
      { key: 'seven_day_opus', utilization: Math.min(100, Math.round(Math.min(0.9, weekElapsed * 0.92) * 100)), resetsAt: reset },
    ],
  };
  // Pretend ccpulse has read the meter for a few weeks, so learned limits show up.
  const history: Snapshot[] = [];
  for (let k = 1; k <= 24; k++) {
    const at = now - k * 7 * HOUR;
    const util = 10 + ((k * 37) % 80);
    history.push({ at, key: 'seven_day', utilization: util, resetsAt: reset, localCost: (weeklyLimit * util) / 100 * (0.95 + ((k * 13) % 10) / 100), localTokens: 0 });
    history.push({ at, key: 'five_hour', utilization: util, resetsAt: at + HOUR, localCost: (sessionLimit * util) / 100 * (0.93 + ((k * 7) % 12) / 100), localTokens: 0 });
  }
  return { entries, official, history };
}
