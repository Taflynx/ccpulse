import { bucketize, groupBy, slice, totalsOf } from './aggregate.js';
import { getAdmin, AdminUnavailable } from './admin.js';
import {
  breakdown,
  burndown,
  concentration,
  contextEconomics,
  costAnatomy,
  detectChangePoint,
  modelMixTrend,
  sessionStats,
  simulateRisk,
  advancedInsights,
  type Breakdown,
  type Burndown,
  type ChangePoint,
  type Concentration,
  type ContextEconomics,
  type CostAnatomy,
  type MixPoint,
  type Risk,
  type SessionStats,
} from './analytics/advanced.js';
import { apiReport, type ApiReport } from './analytics/api.js';
import { planAdvice, planValue, type PlanAdvice, type PlanValue } from './analytics/planvalue.js';
import { detectPlan, type PlanInfo } from './plan.js';
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
  plan: PlanInfo;
  planValue: PlanValue;
  planAdvice: PlanAdvice;
  /** Monte Carlo probability of hitting each cycle's limit before reset. */
  risks: Risk[];
  burndowns: Burndown[];
  changePoint?: ChangePoint;
  advanced: {
    window: { from: number; to: number; days: number };
    anatomy: CostAnatomy;
    context: ContextEconomics;
    sessions: SessionStats;
    byEffort: Breakdown[];
    byEntrypoint: Breakdown[];
    bySubagent: Breakdown[];
    mix: { models: string[]; points: MixPoint[] };
    concentration: Concentration;
  };
  /** Organization API analytics (Admin API), when configured. */
  api?: ApiReport;
  apiError?: string;
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
  /** Include organization API analytics (default: when an Admin API key is configured). */
  api?: boolean;
  /** Skip the heavier analytics (status line, watch). */
  light?: boolean;
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
  // Plan, value and advice.
  const plan = demo ? demoPlan(now) : detectPlan(cfg);
  if (plan.priceSource === 'list' && plan.monthlyPrice)
    plan.notes.push(`Using the list price $${plan.monthlyPrice}/month for value analytics; set plan.monthlyPrice if you pay a different amount.`);
  const pv = planValue(entries, plan, cfg, clock, now, fc);
  const advice = planAdvice(plan, history, pv, now);

  // Monte Carlo limit risk and burn-downs for every cycle with a real limit.
  const risks: Risk[] = [];
  const burndowns: Burndown[] = [];
  for (const c of cycles) {
    if (c.source === 'history') continue;
    const r = simulateRisk(c, entries, costProfile, clock, now, opts.light ? 600 : 2000);
    if (r) {
      risks.push(r);
      applyRisk(c, r, cfg);
    }
    const b = burndown(c, entries, now);
    if (b) burndowns.push(b);
  }

  // Cycle warnings come from the simulation, not the point projection.
  for (let i = ins.length - 1; i >= 0; i--) if (ins[i].id.startsWith('cycle-')) ins.splice(i, 1);
  for (const c of cycles) {
    if (c.pHit === undefined || c.pHit < 0.5 || (c.used ?? 0) >= 1) continue;
    ins.unshift({
      id: `cycle-${c.key}`,
      kind: 'warning',
      title: `${c.label}: ${Math.round(c.pHit * 100)}% chance of hitting the limit before reset`,
      detail:
        (c.etaFull ? `Most likely around ${clock.short(c.etaFull)}, ${Math.round(((c.end - c.etaFull) / 3_600_000) * 10) / 10} h before it resets. ` : '') +
        (c.safeBurnPerHour !== undefined ? `To land at 100% exactly, keep under $${c.safeBurnPerHour.toFixed(2)}/h.` : ''),
    });
  }

  // Deep analytics over the last 30 days.
  const winFrom = now - 30 * DAY;
  const win = opts.light ? [] : slice(entries, winFrom, now + 1);
  const advanced: Analysis['advanced'] = {
    window: { from: winFrom, to: now, days: 30 },
    anatomy: costAnatomy(win),
    context: contextEconomics(win),
    sessions: sessionStats(win),
    byEffort: breakdown(win, (e) => e.effort ?? 'default', 'cost'),
    byEntrypoint: breakdown(win, (e) => e.entrypoint ?? 'unknown', 'cost'),
    bySubagent: breakdown(win, (e) => (e.subagent ? 'subagents' : 'main thread'), 'cost'),
    mix: opts.light ? { models: [], points: [] } : modelMixTrend(entries, clock, metric, now),
    concentration: concentration(win, metric),
  };
  const changePoint = opts.light ? undefined : detectChangePoint(entries, clock, metric, now);
  if (!opts.light) ins.push(...advancedInsights(advanced));

  // Organization API analytics.
  let api: ApiReport | undefined;
  let apiError: string | undefined;
  const wantApi = opts.api ?? (demo ? true : plan.adminConfigured);
  if (wantApi && !opts.light && (demo || !opts.offline)) {
    try {
      const admin = await getAdmin(cfg, { demo: !!demo });
      const apiCfg = demo ? { ...cfg, api: { ...cfg.api, budgets: DEMO_BUDGETS } } : cfg;
      api = await apiReport(admin, apiCfg, now);
    } catch (e) {
      apiError = e instanceof AdminUnavailable ? e.message : `Admin API: ${(e as Error).message}`;
    }
  }

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
    plan,
    planValue: pv,
    planAdvice: advice,
    risks,
    burndowns,
    changePoint,
    advanced,
    api,
    apiError,
    warnings,
  };
}

/** Replace the point projection with the simulation's median and derive status from probability. */
function applyRisk(c: CycleStatus, r: Risk, cfg: Config): void {
  c.projected = r.p50;
  c.pHit = r.pHit;
  c.etaFull = r.pHit >= 0.5 ? r.etaP50 : undefined;
  const used = c.used ?? 0;
  if (c.status === 'idle') return;
  if (used >= 0.9 || r.pHit >= 0.5) c.status = 'critical';
  else if (r.pHit >= 0.2 || used >= 0.75) c.status = 'warn';
  else if (r.pHit >= 0.05 || (c.pace ?? 0) >= cfg.alerts.pace) c.status = 'watch';
  else c.status = 'ok';
}

const DEMO_BUDGETS = [
  { name: 'Production', monthly: 1800, workspaceId: 'wrkspc_demo_prod' },
  { name: 'Research', monthly: 320, workspaceId: 'wrkspc_demo_lab' },
];

function demoPlan(now: number): PlanInfo {
  return {
    kind: 'max',
    label: 'Max 5x',
    multiplier: 5,
    rateLimitTier: 'default_claude_max_5x',
    billingType: 'stripe_subscription',
    extraUsage: false,
    subscriptionStartedAt: now - 209 * DAY,
    monthlyPrice: 100,
    priceSource: 'list',
    auth: { oauth: true, apiKeyEnv: false, apiKeyHelper: false, bedrock: false, vertex: false, foundry: false, customBaseUrl: false },
    adminConfigured: true,
    notes: [],
  };
}
