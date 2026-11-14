import { lowerBound } from '../aggregate.js';
import type { Config } from '../config.js';
import type { Calibration } from '../history.js';
import { windowLabel, windowLength, type OfficialUsage } from '../limits.js';
import { clamp, quantile } from '../stats.js';
import { DAY, HOUR, type Clock } from '../time.js';
import type { Entry } from '../types.js';
import type { Profile } from './baseline.js';

export type LimitSource = 'official' | 'calibrated' | 'configured' | 'history' | 'derived';

export interface CycleStatus {
  key: string;
  label: string;
  /** Where the 100% mark comes from. */
  source: LimitSource;
  start: number;
  end: number;
  /** Share of the cycle that has elapsed, 0..1. */
  elapsed: number;
  /** Share of the limit used, 0..1 (undefined if no limit is known). */
  used?: number;
  /** API-equivalent cost consumed in this cycle (local logs). */
  usedCost: number;
  /** API-equivalent cost that equals 100%. */
  limitCost?: number;
  /** used / elapsed. 1.0 = exactly on pace; above 1 = burning faster than the cycle advances. */
  pace?: number;
  /** Projected share of the limit at reset, 0..1+. */
  projected?: number;
  /** When the limit is projected to be reached, if before reset. */
  etaFull?: number;
  /** Monte Carlo probability of reaching 100% before reset (when simulated). */
  pHit?: number;
  /** Cost per hour you can still burn evenly and land exactly at 100% at reset. */
  safeBurnPerHour?: number;
  /** Recent burn rate in cost per hour. */
  burnPerHour: number;
  /** Model family for per-model windows (e.g. `opus`). */
  family?: string;
  status: 'ok' | 'watch' | 'warn' | 'critical' | 'idle';
  notes: string[];
}

interface Ctx {
  entries: Entry[];
  clock: Clock;
  cfg: Config;
  profile: Profile;
  now: number;
  official?: OfficialUsage;
  calibration: Map<string, Calibration>;
  /** The plan has no rolling 5-hour limit (Ultra): never invent a session window. */
  noSessionLimit?: boolean;
}

function costBetween(entries: Entry[], from: number, to: number, family?: string): number {
  let c = 0;
  for (let i = lowerBound(entries, from); i < entries.length && entries[i].t < to; i++)
    if (!family || entries[i].model.includes(family)) c += entries[i].cost;
  return c;
}

/** `seven_day_opus` → `opus`: per-model windows only count that model family. */
export function windowFamily(key: string): string | undefined {
  const m = key.match(/_(opus|sonnet|haiku|fable)$/);
  return m ? m[1] : undefined;
}

/** ccusage-compatible 5-hour blocks: a block starts at the floored hour of the first message after the previous block ends. */
export function sessionBlocks(entries: Entry[], clock: Clock, from: number): { start: number; end: number; cost: number }[] {
  const blocks: { start: number; end: number; cost: number }[] = [];
  let cur: { start: number; end: number; cost: number } | undefined;
  for (let i = lowerBound(entries, from); i < entries.length; i++) {
    const e = entries[i];
    if (!cur || e.t >= cur.end) {
      const start = clock.bucketStart(e.t, 'hour');
      cur = { start, end: start + 5 * HOUR, cost: 0 };
      blocks.push(cur);
    }
    cur.cost += e.cost;
  }
  return blocks;
}

/** "thu 18:00" → the most recent such instant at or before `now`. */
export function parseWeeklyAnchor(spec: string, clock: Clock, now: number): number | undefined {
  const m = spec.trim().toLowerCase().match(/^(mon|tue|wed|thu|fri|sat|sun)\w*\s+(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return undefined;
  const target = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(m[1]);
  const p = clock.parts(now);
  const back = (p.dow - target + 7) % 7;
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d - back));
  let ts = clock.toEpoch(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), +m[2], m[3] ? +m[3] : 0);
  if (ts > now) ts -= 7 * DAY;
  return ts;
}

function burnRate(entries: Entry[], now: number, windowMs: number, family?: string): number {
  return costBetween(entries, now - windowMs, now, family) / (windowMs / HOUR);
}

/** How the user is running relative to their own typical pattern over the last 24h (1 = normal). */
function intensity(ctx: Ctx): number {
  const actual = costBetween(ctx.entries, ctx.now - DAY, ctx.now);
  const expected = ctx.profile.expectedBetween(ctx.now - DAY, ctx.now);
  if (expected <= 0) return 1;
  return clamp(actual / expected, 0.3, 3);
}

function finish(ctx: Ctx, c: Omit<CycleStatus, 'status' | 'pace' | 'projected' | 'etaFull' | 'safeBurnPerHour'>, mode: 'short' | 'long'): CycleStatus {
  const out: CycleStatus = { ...c, status: 'ok' };
  const remainingMs = Math.max(0, c.end - ctx.now);
  if (c.used !== undefined && c.elapsed > 0) out.pace = c.used / Math.max(c.elapsed, 0.02);

  if (c.limitCost && c.limitCost > 0) {
    // Short windows extrapolate the live burn rate; long windows use the learned weekly
    // profile scaled by how intense the last 24h were compared to normal.
    // Per-model windows: the profile covers all models, so scale it by this family's recent share.
    const all7 = costBetween(ctx.entries, ctx.now - 7 * DAY, ctx.now);
    const share = c.family ? (all7 > 0 ? costBetween(ctx.entries, ctx.now - 7 * DAY, ctx.now, c.family) / all7 : 0) : 1;
    let futureCost: number;
    if (mode === 'short') {
      futureCost = c.burnPerHour * (remainingMs / HOUR);
    } else {
      futureCost = ctx.profile.expectedBetween(ctx.now, c.end) * intensity(ctx) * share;
    }
    const usedFrac = c.used ?? c.usedCost / c.limitCost;
    const costPerFrac = c.limitCost;
    out.projected = usedFrac + futureCost / costPerFrac;
    out.safeBurnPerHour = remainingMs > 0 ? Math.max(0, (1 - usedFrac) * costPerFrac) / (remainingMs / HOUR) : 0;

    if (out.projected >= 1 && usedFrac < 1) {
      const need = (1 - usedFrac) * costPerFrac;
      if (mode === 'short') {
        out.etaFull = c.burnPerHour > 0 ? ctx.now + (need / c.burnPerHour) * HOUR : undefined;
      } else {
        const k = intensity(ctx) * share;
        let acc = 0;
        for (let t = ctx.now; t < c.end; t += 15 * 60_000) {
          acc += ctx.profile.expectedBetween(t, Math.min(t + 15 * 60_000, c.end)) * k;
          if (acc >= need) {
            out.etaFull = t + 15 * 60_000;
            break;
          }
        }
      }
    } else if (usedFrac >= 1) {
      out.etaFull = ctx.now;
    }
  }

  const used = c.used ?? (c.limitCost ? c.usedCost / c.limitCost : undefined);
  if (c.usedCost === 0 && c.burnPerHour === 0) out.status = 'idle';
  else if (c.source === 'history') {
    // No real limit known: compare against your own history, but never claim a limit is near.
    out.status = (used ?? 0) >= 1 || (out.pace ?? 0) >= ctx.cfg.alerts.pace ? 'watch' : 'ok';
    out.etaFull = undefined;
  }
  else if ((used ?? 0) >= 0.9 || (out.etaFull !== undefined && out.etaFull < c.end)) out.status = 'critical';
  else if ((out.pace ?? 0) >= ctx.cfg.alerts.pace || (used ?? 0) >= 0.75) out.status = 'warn';
  else if ((out.pace ?? 0) >= 1.05) out.status = 'watch';
  return out;
}

/**
 * A cap on one model family expressed as a share of the weekly limit (Max/Ultra: Fable up to half
 * the weekly limit). Derived from the weekly window's 100% mark, so it is only as good as that.
 */
export function familyCapCycle(ctx: Ctx, weekly: CycleStatus, family: string, share: number, label: string): CycleStatus | undefined {
  if (!weekly.limitCost || weekly.source === 'history' || weekly.label.includes('rolling')) return undefined;
  const limitCost = weekly.limitCost * share;
  const usedCost = costBetween(ctx.entries, weekly.start, ctx.now, family);
  if (usedCost <= 0) return undefined;
  return finish(
    ctx,
    {
      key: `seven_day_${family}_cap`,
      label,
      source: 'derived',
      start: weekly.start,
      end: weekly.end,
      elapsed: weekly.elapsed,
      used: usedCost / limitCost,
      usedCost,
      limitCost,
      burnPerHour: burnRate(ctx.entries, ctx.now, 6 * HOUR, family),
      family,
      notes: [`Estimated: ${Math.round(share * 100)}% of the weekly limit, as the plan allows for ${family[0].toUpperCase()}${family.slice(1)}.`],
    },
    'long',
  );
}

export function computeCycles(ctx: Ctx): CycleStatus[] {
  const { entries, clock, cfg, now, official, calibration } = ctx;
  const out: CycleStatus[] = [];
  const seen = new Set<string>();

  if (official) {
    for (const w of official.windows) {
      const len = windowLength(w.key);
      if (!len || !w.resetsAt) continue;
      const start = w.resetsAt - len;
      const family = windowFamily(w.key);
      const usedCost = costBetween(entries, start, now, family);
      const used = w.utilization / 100;
      const cal = calibration.get(w.key);
      // Prefer the live ratio; for tiny readings (rounded to whole %) lean on the learned limit.
      let limitCost = used >= 0.05 && usedCost > 0 ? usedCost / used : cal && Number.isFinite(cal.limitCost) ? cal.limitCost : undefined;
      const notes: string[] = [];
      if (cal && Number.isFinite(cal.limitCost) && used >= 0.05 && usedCost > 0 && cal.limitCost > limitCost! * 1.6)
        notes.push('Your plan meter is ahead of local logs. Other devices or claude.ai usage likely count too.');
      out.push(
        finish(
          ctx,
          {
            key: w.key,
            label: windowLabel(w.key),
            source: 'official',
            start,
            end: w.resetsAt,
            elapsed: clamp((now - start) / len, 0, 1),
            used,
            usedCost,
            limitCost,
            burnPerHour: burnRate(entries, now, len <= DAY ? HOUR : 6 * HOUR, family),
            family,
            notes,
          },
          len <= DAY ? 'short' : 'long',
        ),
      );
      seen.add(w.key);
    }
  }

  if (!seen.has('five_hour') && !ctx.noSessionLimit) {
    const blocks = sessionBlocks(entries, clock, now - 60 * DAY);
    const active = blocks.length && blocks[blocks.length - 1].end > now ? blocks[blocks.length - 1] : undefined;
    const past = blocks.filter((b) => b !== active).map((b) => b.cost);
    const cal = calibration.get('five_hour');
    let source: LimitSource = 'history';
    let limitCost: number | undefined;
    if (cal && Number.isFinite(cal.limitCost)) [source, limitCost] = ['calibrated', cal.limitCost];
    else if (cfg.limits.sessionCost) [source, limitCost] = ['configured', cfg.limits.sessionCost];
    else if (past.length >= 5) limitCost = quantile(past, 0.95);
    const start = active?.start ?? now;
    const end = active?.end ?? now + 5 * HOUR;
    const usedCost = active?.cost ?? 0;
    out.unshift(
      finish(
        ctx,
        {
          key: 'five_hour',
          label: windowLabel('five_hour'),
          source,
          start,
          end,
          elapsed: active ? clamp((now - start) / (5 * HOUR), 0, 1) : 0,
          used: limitCost ? usedCost / limitCost : undefined,
          usedCost,
          limitCost,
          burnPerHour: burnRate(entries, now, HOUR),
          notes: source === 'history' ? ['100% = your 95th-percentile session (no plan meter available).'] : [],
        },
        'short',
      ),
    );
  }

  if (!seen.has('seven_day')) {
    const cal = calibration.get('seven_day');
    let anchor: number | undefined;
    if (cal?.lastResetsAt) {
      anchor = cal.lastResetsAt;
      while (anchor > now) anchor -= 7 * DAY;
      while (anchor + 7 * DAY <= now) anchor += 7 * DAY;
    } else if (cfg.limits.weeklyReset) {
      anchor = parseWeeklyAnchor(cfg.limits.weeklyReset, clock, now);
    }
    const rolling = anchor === undefined;
    const start = anchor ?? now - 7 * DAY;
    const end = rolling ? now : start + 7 * DAY;
    const usedCost = costBetween(entries, start, now);
    let source: LimitSource = 'history';
    let limitCost: number | undefined;
    if (cal && Number.isFinite(cal.limitCost)) [source, limitCost] = ['calibrated', cal.limitCost];
    else if (cfg.limits.weeklyCost) [source, limitCost] = ['configured', cfg.limits.weeklyCost];
    else {
      const past: number[] = [];
      for (let k = 1; k <= 12; k++) {
        const s = start - k * 7 * DAY;
        if (entries.length && s + 7 * DAY < entries[0].t) break;
        past.push(costBetween(entries, s, s + 7 * DAY));
      }
      if (past.length >= 3) limitCost = Math.max(...past);
    }
    const notes: string[] = [];
    if (rolling) notes.push('Reset time unknown, so this is a rolling 7 days. Set limits.weeklyReset (e.g. "thu 18:00") or let ccpulse read the plan meter once.');
    if (source === 'history') notes.push('100% = your heaviest week of the last 12 (no plan meter available).');
    const label = rolling ? 'Last 7 days (rolling)' : windowLabel('seven_day');
    out.splice(1, 0, {
      ...finish(
        ctx,
        {
          key: 'seven_day',
          label,
          source,
          start,
          end,
          elapsed: rolling ? 1 : clamp((now - start) / (7 * DAY), 0, 1),
          used: limitCost ? usedCost / limitCost : undefined,
          usedCost,
          limitCost,
          burnPerHour: burnRate(entries, now, 6 * HOUR),
          notes,
        },
        'long',
      ),
      ...(rolling ? { pace: undefined, projected: undefined, etaFull: undefined, safeBurnPerHour: undefined } : {}),
    });
  }
  return out;
}
