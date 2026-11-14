import { bucketize, groupBy, totalsOf } from './aggregate.js';
import { detectAnomalies, type Anomaly } from './analytics/anomalies.js';
import { buildProfile } from './analytics/baseline.js';
import { computeCycles, type CycleStatus } from './analytics/cycle.js';
import { forecast, type Forecast } from './analytics/forecast.js';
import { habits, insights, type Habits, type Insight } from './analytics/insights.js';
import type { Config } from './config.js';
import { calibrate, readHistory, recordSnapshot, type Calibration } from './history.js';
import { fetchOfficial, type OfficialResult } from './limits.js';
import { demoData } from './demo.js';
import { loadEntries } from './loader.js';
import { unknownPricedModels } from './pricing.js';
import { Clock, DAY, HOUR } from './time.js';
import type { Bucket, Entry, Totals } from './types.js';

export interface Analysis {
  generatedAt: number;
  timezone: string;
  weekStart: Config['weekStart'];
  metric: Config['metric'];
  firstSeen?: number;
  entries: number;
  totals: { today: Totals; week: Totals; month: Totals; allTime: Totals };
  series: { hour: Bucket[]; day: Bucket[]; week: Bucket[]; month: Bucket[] };
  /** Expected value per hour for the hourly series (the learned profile), for "normal" bands. */
  hourExpected: number[];
  cycles: CycleStatus[];
  official: { available: boolean; reason?: string; fetchedAt?: number };
  calibration: Calibration[];
  forecast: Forecast;
  anomalies: Anomaly[];
  habits: Habits;
  insights: Insight[];
  models: { model: string; totals: Totals }[];
  projects: { project: string; totals: Totals }[];
  warnings: string[];
}

export interface AnalyzeOptions {
  offline?: boolean;
  fresh?: boolean;
  progress?: boolean;
  now?: number;
  /** Pre-loaded entries (tests, dashboard refresh). */
  entries?: Entry[];
  anomalyDays?: number;
  /** Synthetic data (`--demo`): never touches real logs, the network or learned history. */
  demo?: boolean;
}

export async function analyze(cfg: Config, opts: AnalyzeOptions = {}): Promise<Analysis> {
  const now = opts.now ?? Date.now();
  const demo = opts.demo ? demoData(now, cfg.timezone) : undefined;
  const entries = demo?.entries ?? opts.entries ?? (await loadEntries({ fresh: opts.fresh, progress: opts.progress })).entries;
  const clock = new Clock(cfg.timezone, cfg.weekStart);
  const metric = cfg.metric;
  const warnings: string[] = [];

  let official: OfficialResult = { ok: false, reason: 'disabled (offline or limits.useOfficial=false)' };
  if (demo) official = { ok: true, usage: demo.official, cached: true };
  else if (!opts.offline && cfg.limits.useOfficial) official = await fetchOfficial();
  let history = demo ? demo.history : readHistory();
  if (!demo && official.ok && !official.cached) history = history.concat(recordSnapshot(official.usage, entries, history));
  const calibration = calibrate(history);

  const metricProfile = buildProfile(entries, clock, metric, now);
  const costProfile = metric === 'cost' ? metricProfile : buildProfile(entries, clock, 'cost', now);

  const cycles = computeCycles({
    entries,
    clock,
    cfg,
    profile: costProfile,
    now,
    official: official.ok ? official.usage : undefined,
    calibration,
  });
  const fc = forecast(entries, clock, metric, metricProfile, now);
  const anomalies = detectAnomalies(entries, clock, {
    metric,
    z: cfg.alerts.anomalyZ,
    min: cfg.alerts.anomalyMin,
    now,
    lookbackDays: opts.anomalyDays ?? 7,
  });
  const hb = habits(entries, clock, metric, now);
  const ins = insights(entries, clock, metric, now, hb, fc, cycles);

  const hourFrom = clock.bucketStart(now - 47 * HOUR, 'hour');
  const hourSeries = bucketize(entries, clock, 'hour', hourFrom, now + 1);
  const unknown = unknownPricedModels();
  if (unknown.length) warnings.push(`No price for: ${unknown.join(', ')} (counted as $0). Add them to ~/.config/ccpulse/pricing.json.`);

  const first = entries[0]?.t;
  const startOf = (g: 'day' | 'week' | 'month', back: number) => {
    let s = clock.bucketStart(now, g);
    for (let i = 0; i < back; i++) s = clock.bucketStart(s - 1, g);
    return first ? Math.max(s, clock.bucketStart(first, g)) : s;
  };

  return {
    generatedAt: now,
    timezone: clock.tz,
    weekStart: cfg.weekStart,
    metric,
    firstSeen: first,
    entries: entries.length,
    totals: {
      today: totalsOf(entries, clock.bucketStart(now, 'day'), now + 1),
      week: totalsOf(entries, clock.bucketStart(now, 'week'), now + 1),
      month: totalsOf(entries, clock.bucketStart(now, 'month'), now + 1),
      allTime: totalsOf(entries),
    },
    series: {
      hour: hourSeries,
      day: bucketize(entries, clock, 'day', startOf('day', 89), now + 1),
      week: bucketize(entries, clock, 'week', startOf('week', 25), now + 1),
      month: bucketize(entries, clock, 'month', startOf('month', 11), now + 1),
    },
    hourExpected: hourSeries.map((b) => metricProfile.expected(b.start)),
    cycles,
    official: official.ok ? { available: true, fetchedAt: official.usage.fetchedAt } : { available: false, reason: official.reason },
    calibration: [...calibration.values()],
    forecast: fc,
    anomalies,
    habits: hb,
    insights: ins,
    models: [...groupBy(entries, (e) => e.model, now - 30 * DAY, now + 1)]
      .map(([model, totals]) => ({ model, totals }))
      .sort((a, b) => b.totals.cost - a.totals.cost),
    projects: [...groupBy(entries, (e) => e.project, now - 30 * DAY, now + 1)]
      .map(([project, totals]) => ({ project, totals }))
      .sort((a, b) => b.totals.cost - a.totals.cost),
    warnings,
  };
}
