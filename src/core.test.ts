import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { evaluate } from './alerts.js';
import { analyze } from './analysis.js';
import { detectAnomalies } from './analytics/anomalies.js';
import { buildProfile } from './analytics/baseline.js';
import { computeCycles, parseWeeklyAnchor, sessionBlocks } from './analytics/cycle.js';
import { predictDay, type DayPoint } from './analytics/forecast.js';
import { defaults, type Config } from './config.js';
import { calibrate, type Snapshot } from './history.js';
import { parseOfficial } from './limits.js';
import { dedupe, parseLine } from './loader.js';
import { costOf, normalizeModel } from './pricing.js';
import { bucketize } from './aggregate.js';
import { Clock, DAY, HOUR } from './time.js';
import type { Entry } from './types.js';

// Never touch the real user's config, cache or learned history.
const sandbox = mkdtempSync(path.join(tmpdir(), 'ccpulse-test-'));
for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) process.env[k] = path.join(sandbox, k);

const cfg = (over: Partial<Config> = {}): Config => ({ ...structuredClone(defaults), ...over, timezone: 'UTC' });

function entry(t: number, cost: number, extra: Partial<Entry> = {}): Entry {
  return {
    t,
    model: 'claude-sonnet-5.5',
    project: 'p',
    sessionId: 's',
    input: 0,
    output: 1000,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    cost,
    ...extra,
  };
}

function line(o: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-11-10T12:00:00.000Z',
    sessionId: 'sess',
    cwd: '/home/u/proj',
    requestId: 'req_1',
    message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 } } },
    ...o,
  });
}

test('normalizeModel handles dated, dashed, legacy and alias forms', () => {
  assert.equal(normalizeModel('claude-opus-5-5'), 'claude-opus-5.5');
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4.5');
  assert.equal(normalizeModel('claude-3-5-sonnet'), 'claude-sonnet-3.5');
  assert.equal(normalizeModel('us.anthropic.claude-sonnet-5-5-v1:0'), 'claude-sonnet-5.5');
  assert.equal(normalizeModel('opus'), 'claude-opus-5.5');
  assert.equal(normalizeModel('claude-opus-5'), 'claude-opus-5');
});

test('costOf prices 1h cache writes at 2x input and applies long-context tiers', () => {
  // claude-opus-5.5: input 4, output 20, cache read 0.2 per MTok
  const c = costOf('claude-opus-5.5', { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 1_000_000, cacheRead: 0 });
  assert.equal(Math.round(c * 100) / 100, 4 + 8);
  // claude-sonnet-4.5 has a >200k tier: input 6 instead of 3
  const small = costOf('claude-sonnet-4.5', { input: 100_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
  const big = costOf('claude-sonnet-4.5', { input: 300_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
  assert.ok(Math.abs(small - 0.3) < 1e-9);
  assert.ok(Math.abs(big - 1.8) < 1e-9);
  assert.equal(costOf('totally-unknown-model', { input: 1, output: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }), 0);
});

test('parseLine reads usage, splits cache TTLs and uses cwd for the project', () => {
  const r = parseLine(line({}), 'fallback')!;
  assert.ok(r);
  assert.equal(r[4], 'proj');
  assert.equal(r[7], 0); // 5m writes
  assert.equal(r[8], 200); // 1h writes
  assert.equal(parseLine(JSON.stringify({ type: 'user', message: { content: 'usage' } }), 'x'), undefined);
  assert.equal(parseLine('{not json "usage" "assistant"', 'x'), undefined);
});

test('dedupe collapses content-block copies and sidechain replays like ccusage', () => {
  const a = parseLine(line({}), 'p')!;
  const sameBlock = parseLine(line({}), 'p')!;
  const sidechainReplay = parseLine(line({ isSidechain: true, requestId: 'req_other' }), 'p')!;
  const other = parseLine(line({ requestId: 'req_2', message: { id: 'msg_2', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } } }), 'p')!;
  const out = dedupe([a, sameBlock, sidechainReplay, other]);
  assert.equal(out.length, 2);
  assert.ok(out.every((e) => e.cost > 0));
});

test('Clock buckets stay contiguous across DST changes and odd offsets', () => {
  for (const tz of ['America/Toronto', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe']) {
    const c = new Clock(tz);
    const from = Date.UTC(2026, 9, 20);
    const hours = bucketize([], c, 'hour', from, from + 20 * DAY);
    // Zones with :30/:45 offsets start one partial hour earlier.
    assert.ok(hours.length === 480 || hours.length === 481, `${tz} ${hours.length}`);
    for (let i = 1; i < hours.length; i++) assert.equal(hours[i].start - hours[i - 1].start, HOUR, tz);
    const days = bucketize([], c, 'day', from, from + 20 * DAY);
    assert.ok(days.length >= 20 && days.length <= 21, tz);
  }
});

test('parseOfficial accepts any {utilization, resets_at} window', () => {
  const u = parseOfficial({
    five_hour: { utilization: 42, resets_at: '2026-11-14T20:00:00Z' },
    seven_day: { utilization: 61.5, resets_at: '2026-11-19T18:00:00Z' },
    seven_day_opus: null,
    extra: { enabled: false },
  });
  assert.deepEqual(
    u.windows.map((w) => [w.key, w.utilization]),
    [
      ['five_hour', 42],
      ['seven_day', 61.5],
    ],
  );
});

test('weekly anchor parsing returns the latest past occurrence', () => {
  const c = new Clock('UTC');
  const now = Date.UTC(2026, 10, 14, 12); // Saturday
  assert.equal(parseWeeklyAnchor('thu 18:00', c, now), Date.UTC(2026, 10, 12, 18));
  assert.equal(parseWeeklyAnchor('sat 13:00', c, now), Date.UTC(2026, 10, 7, 13));
  assert.equal(parseWeeklyAnchor('nonsense', c, now), undefined);
});

test('session blocks follow the 5-hour floored-hour rule', () => {
  const c = new Clock('UTC');
  const t0 = Date.UTC(2026, 10, 14, 9, 37);
  const b = sessionBlocks([entry(t0, 1), entry(t0 + 4 * HOUR, 1), entry(t0 + 6 * HOUR, 1)], c, 0);
  assert.equal(b.length, 2);
  assert.equal(b[0].start, Date.UTC(2026, 10, 14, 9));
  assert.equal(b[0].cost, 2);
});

test('pace, projection and alerts from the plan meter', () => {
  const c = new Clock('UTC');
  const resetsAt = Date.UTC(2026, 10, 19, 0);
  const start = resetsAt - 7 * DAY;
  const now = start + 2 * DAY; // 28.6% elapsed
  // Steady $10/hour for 2 days.
  const entries: Entry[] = [];
  for (let t = start; t < now; t += HOUR) entries.push(entry(t, 10));
  const official = { fetchedAt: now, windows: [{ key: 'seven_day', utilization: 60, resetsAt }] };
  const config = cfg();
  const cycles = computeCycles({ entries, clock: c, cfg: config, profile: buildProfile(entries, c, 'cost', now), now, official, calibration: new Map() });
  const wk = cycles.find((x) => x.key === 'seven_day')!;
  assert.equal(wk.source, 'official');
  assert.ok(Math.abs(wk.elapsed - 2 / 7) < 1e-9);
  assert.ok(Math.abs(wk.pace! - 0.6 / (2 / 7)) < 1e-9); // 2.1x
  assert.ok(Math.abs(wk.limitCost! - 480 / 0.6) < 1e-6);
  assert.ok(wk.projected! > 1);
  assert.ok(wk.etaFull! > now && wk.etaFull! < resetsAt);
  assert.equal(wk.status, 'critical');

  const analysis = { cycles, anomalies: [], generatedAt: now, timezone: 'UTC' } as any;
  const alerts = evaluate(analysis, config);
  assert.ok(alerts.some((a) => a.key.startsWith('pace:seven_day')));
  assert.ok(alerts.some((a) => a.key === `threshold:seven_day:${start}:50`));
});

test('history-based limits never raise limit alerts', () => {
  const c = new Clock('UTC');
  const now = Date.UTC(2026, 10, 14, 12);
  const entries: Entry[] = [];
  for (let t = now - 30 * DAY; t < now; t += HOUR) entries.push(entry(t, t > now - 3 * HOUR ? 50 : 1));
  const config = cfg();
  const cycles = computeCycles({ entries, clock: c, cfg: config, profile: buildProfile(entries, c, 'cost', now), now, calibration: new Map() });
  assert.ok(cycles.every((x) => x.source === 'history'));
  assert.ok(cycles.every((x) => x.status !== 'critical'));
  assert.equal(evaluate({ cycles, anomalies: [], generatedAt: now, timezone: 'UTC' } as any, config).length, 0);
});

test('calibration learns the cost of 100% from snapshots', () => {
  const snaps: Snapshot[] = [10, 20, 40, 80].map((u, i) => ({ at: i, key: 'seven_day', utilization: u, resetsAt: 1000, localCost: u * 5, localTokens: 0 }));
  const cal = calibrate(snaps).get('seven_day')!;
  assert.equal(cal.limitCost, 500);
  assert.equal(cal.samples, 4);
  assert.equal(cal.lastResetsAt, 1000);
});

test('predictDay learns weekday seasonality', () => {
  const hist: DayPoint[] = [];
  for (let i = 0; i < 56; i++) hist.push({ start: i * DAY, label: '', wi: i % 7, value: i % 7 >= 5 ? 10 : 100 });
  const weekday = predictDay(hist, 0);
  const weekend = predictDay(hist, 6);
  assert.ok(weekday > 70 && weekday < 130, `weekday ${weekday}`);
  assert.ok(weekend < weekday / 3, `weekend ${weekend}`);
});

test('anomaly detection flags a spike hour but not normal variation', () => {
  const c = new Clock('UTC');
  const now = Date.UTC(2026, 10, 14, 12, 30);
  const entries: Entry[] = [];
  for (let t = now - 35 * DAY; t < now - HOUR; t += HOUR) entries.push(entry(t, 1 + ((t / HOUR) % 3) * 0.2));
  entries.push(entry(now - 40 * 60_000, 60));
  entries.sort((a, b) => a.t - b.t);
  const found = detectAnomalies(entries, c, { metric: 'cost', z: 4, min: 2, now, lookbackDays: 2 });
  const hours = found.filter((a) => a.kind === 'hour');
  assert.equal(hours.length, 1);
  assert.equal(hours[0].start, Date.UTC(2026, 10, 14, 11));
});

test('analyze runs end-to-end on synthetic data without network', async () => {
  const now = Date.UTC(2026, 10, 14, 12);
  const entries: Entry[] = [];
  for (let t = now - 60 * DAY; t < now; t += HOUR) {
    const h = new Date(t).getUTCHours();
    if (h >= 9 && h <= 18) entries.push(entry(t, 2, { model: h % 2 ? 'claude-opus-5.5' : 'claude-sonnet-5.5', sessionId: `s${Math.floor(t / (4 * HOUR))}` }));
  }
  const a = await analyze(cfg(), { entries, now, offline: true });
  assert.equal(a.series.hour.length, 48);
  assert.ok(a.forecast.today.value >= a.forecast.today.actualSoFar);
  assert.ok(Number.isFinite(a.forecast.accuracy.wape));
  assert.ok(a.forecast.accuracy.wape < 0.3, `wape ${a.forecast.accuracy.wape}`);
  assert.ok(a.insights.some((i) => i.id === 'peak-hours'));
  assert.equal(a.cycles.length, 2);
});
