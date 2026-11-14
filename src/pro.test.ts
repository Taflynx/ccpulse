import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const sandbox = mkdtempSync(path.join(tmpdir(), 'ccpulse-pro-'));
for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) process.env[k] = path.join(sandbox, k);

const { evaluate } = await import('./alerts.js');
const { costAnatomy, detectChangePoint, simulateRisk, sessionStats } = await import('./analytics/advanced.js');
const { buildProfile } = await import('./analytics/baseline.js');
const { apiReport } = await import('./analytics/api.js');
const { planAdvice } = await import('./analytics/planvalue.js');
const { demoAdmin } = await import('./admin-demo.js');
const { defaults } = await import('./config.js');
const { billingPeriod, detectPlan } = await import('./plan.js');
const { Clock, DAY, HOUR } = await import('./time.js');
type Entry = import('./types.js').Entry;
type CycleStatus = import('./analytics/cycle.js').CycleStatus;

const cfg = () => ({ ...structuredClone(defaults), timezone: 'UTC' });
const entry = (t: number, cost: number, extra: Partial<Entry> = {}): Entry => ({
  t, model: 'claude-opus-5.5', project: 'p', sessionId: 's', input: 0, output: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, cost, ...extra,
});

test('detectPlan reads plan metadata from Claude Code config without secrets', () => {
  const dir = path.join(sandbox, 'claude');
  mkdirSync(path.join(dir, 'projects'), { recursive: true });
  writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x', billingType: 'stripe_subscription', hasExtraUsageEnabled: true, subscriptionCreatedAt: '2026-03-18T01:04:32Z', emailAddress: 'secret@example.com' } }),
  );
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const p = detectPlan(cfg());
    assert.equal(p.kind, 'max');
    assert.equal(p.label, 'Max 5x');
    assert.equal(p.multiplier, 5);
    assert.equal(p.extraUsage, true);
    assert.equal(p.monthlyPrice, 100);
    assert.equal(p.priceSource, 'list');
    assert.ok(!JSON.stringify(p).includes('secret@example.com'));
    assert.ok(!JSON.stringify(p).includes('tok'));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('billing period follows the subscription timestamp and clamps short months', () => {
  const plan = { subscriptionStartedAt: Date.parse('2026-03-18T01:04:32Z') } as any;
  const b = billingPeriod(plan, cfg(), new Clock('UTC'), Date.parse('2026-11-14T12:00:00Z'))!;
  assert.equal(new Date(b.start).toISOString(), '2026-10-18T01:04:32.000Z');
  assert.equal(new Date(b.end).toISOString(), '2026-11-18T01:04:32.000Z');
  assert.equal(b.days, 31);
  const p31 = { subscriptionStartedAt: Date.parse('2026-01-31T00:00:00Z') } as any;
  const f = billingPeriod(p31, cfg(), new Clock('UTC'), Date.parse('2026-02-15T00:00:00Z'))!;
  assert.equal(new Date(f.end).toISOString(), '2026-02-28T00:00:00.000Z');
});

function weeklyCycle(start: number, now: number, used: number, limit: number): CycleStatus {
  return { key: 'seven_day', label: 'Weekly', source: 'official', start, end: start + 7 * DAY, elapsed: (now - start) / (7 * DAY), used, usedCost: used * limit, limitCost: limit, burnPerHour: 1, status: 'ok', notes: [] };
}

test('Monte Carlo risk: high when far ahead of pace, ~0 when far behind, deterministic', () => {
  const c = new Clock('UTC');
  const now = Date.UTC(2026, 10, 14, 12);
  const entries: Entry[] = [];
  for (let t = now - 60 * DAY; t < now; t += HOUR) entries.push(entry(t, 1 + ((t / HOUR) % 5) * 0.3));
  const prof = buildProfile(entries, c, 'cost', now);
  const start = now - 2 * DAY; // 2 of 7 days elapsed; normal week ≈ 7*24*1.6 ≈ 270
  const hot = simulateRisk(weeklyCycle(start, now, 0.6, 300), entries, prof, c, now)!;
  const cold = simulateRisk(weeklyCycle(start, now, 0.05, 3000), entries, prof, c, now)!;
  assert.ok(hot.pHit > 0.9, `hot ${hot.pHit}`);
  assert.ok(cold.pHit < 0.01, `cold ${cold.pHit}`);
  assert.ok(hot.p10 <= hot.p50 && hot.p50 <= hot.p90);
  const again = simulateRisk(weeklyCycle(start, now, 0.6, 300), entries, prof, c, now)!;
  assert.equal(again.pHit, hot.pHit);
  assert.ok(hot.fan.length > 0 && hot.fan[hot.fan.length - 1].t <= start + 7 * DAY + 1);
});

test('change-point detection finds a level shift and its date', () => {
  const c = new Clock('UTC');
  const now = Date.UTC(2026, 10, 14, 12);
  const shift = Date.UTC(2026, 9, 15);
  const entries: Entry[] = [];
  for (let d = now - 80 * DAY; d < now; d += DAY) {
    const base = d < shift ? 10 : 40;
    for (let h = 0; h < 8; h++) entries.push(entry(d + (9 + h) * HOUR, (base / 8) * (0.8 + ((d / DAY) % 3) * 0.2)));
  }
  const cp = detectChangePoint(entries, c, 'cost', now)!;
  assert.ok(cp, 'expected a change point');
  assert.ok(Math.abs(cp.at - shift) <= 2 * DAY, new Date(cp.at).toISOString());
  assert.ok(cp.change > 2 && cp.change < 4, `change ${cp.change}`);
});

test('cost anatomy adds up to the priced total, and sessions split at idle gaps', () => {
  const t0 = Date.UTC(2026, 10, 1);
  const es = [
    entry(t0, 0, { input: 1000, output: 2000, cacheRead: 100_000, cacheWrite1h: 5000, thinking: 500 }),
    entry(t0 + 60_000, 0, { input: 10, output: 100, cacheRead: 50_000 }),
    entry(t0 + 5 * HOUR, 0, { input: 10, output: 100, cacheRead: 50_000 }),
  ];
  const an = costAnatomy(es);
  assert.ok(Math.abs(an.total - (an.input + an.output + an.cacheRead + an.cacheWrite1h + an.cacheWrite5m)) < 1e-9);
  assert.ok(an.withoutCache > an.total);
  const s = sessionStats(es);
  assert.equal(s.count, 1); // the first two requests form a run; the third is a one-shot after 5h idle
  assert.equal(s.oneShot, 1);
});

test('API report: budgets, forecast, anomalies and hygiene from the demo org', async () => {
  const conf = cfg();
  conf.api.budgets = [{ name: 'Research', monthly: 100, workspaceId: 'wrkspc_demo_lab' }];
  const r = await apiReport(demoAdmin(), conf);
  assert.ok(r.month.projected >= r.month.spend);
  assert.ok(r.month.lo <= r.month.projected && r.month.projected <= r.month.hi + 1e-9);
  assert.equal(r.budgets[0].status, 'critical');
  assert.ok(r.anomalies.some((a) => a.driver.includes('research')));
  assert.ok(r.hygiene.some((h) => h.title.includes('unused')));
  assert.ok(r.byWorkspace[0].share > 0.5);
});

test('plan advice: downgrade when a 20x plan never gets busy, upgrade when repeatedly at the limit', () => {
  const now = Date.UTC(2026, 10, 14);
  const snaps = (peaks: number[]) =>
    peaks.flatMap((p, i) => [0.5, 1].map((f) => ({ at: now - (i * 7 + 1) * DAY, key: 'seven_day', utilization: p * 100 * f, resetsAt: now - i * 7 * DAY, localCost: 1, localTokens: 1 })));
  const base = { kind: 'max', label: 'Max 20x', multiplier: 20, auth: {}, notes: [] } as any;
  assert.equal(planAdvice(base, snaps([0.1, 0.12, 0.08, 0.15]), { valueProjected: 0 } as any, now).verdict, 'downgrade');
  assert.equal(planAdvice({ ...base, multiplier: 5, label: 'Max 5x' }, snaps([1, 0.97, 0.5, 0.6]), { valueProjected: 0 } as any, now).verdict, 'upgrade');
  assert.equal(planAdvice(base, [], { valueProjected: 0 } as any, now).verdict, 'insufficient-data');
});

test('alerts: probability drives limit alerts; low-risk pace stays quiet', () => {
  const now = Date.UTC(2026, 10, 14, 12);
  const base = { anomalies: [], generatedAt: now, timezone: 'UTC' } as any;
  const cyc = (pHit: number, pace: number): CycleStatus => ({ ...weeklyCycle(now - 2 * DAY, now, 0.4, 100), pHit, pace, status: 'warn' });
  const risky = evaluate({ ...base, cycles: [cyc(0.7, 1.4)] }, cfg());
  assert.ok(risky.some((a) => a.key.startsWith('risk:seven_day')));
  const calm = evaluate({ ...base, cycles: [cyc(0.02, 1.5)] }, cfg());
  assert.ok(!calm.some((a) => a.key.startsWith('pace:') || a.key.startsWith('risk:')));
});
