import { bucketize, groupBy } from './aggregate.js';
import type { Analysis } from './analysis.js';
import type { CycleStatus } from './analytics/cycle.js';
import type { Config } from './config.js';
import { c, money, paceBar, pct, signed, sparkline, statusBadge, table, tokens, wordWrap } from './render/term.js';
import { pctChange } from './stats.js';
import { Clock, duration } from './time.js';
import { metricOf, type Entry, type Granularity, type Metric } from './types.js';

const SOURCE_LABEL: Record<string, string> = {
  official: 'plan meter',
  calibrated: 'learned limit',
  configured: 'your config',
  history: 'vs. your history',
  derived: 'estimated from weekly limit',
};

function val(v: number, m: Metric): string {
  return m === 'cost' ? money(v) : tokens(v);
}

function cycleLines(cy: CycleStatus, clock: Clock, now: number, detailed: boolean): string[] {
  const lines: string[] = [];
  const used = cy.used;
  const head =
    `${c.bold(cy.label.padEnd(20))} ${paceBar(used, cy.elapsed)}  ` +
    `${c.bold(pct(used).padStart(4))} used  ${c.dim('·')}  ${pct(cy.elapsed).padStart(4)} of cycle  ${statusBadge(cy.status)}`;
  lines.push(head);
  const bits: string[] = [];
  if (cy.pace !== undefined) {
    const p = cy.pace;
    bits.push(`pace ${p >= 1.25 ? c.red(p.toFixed(2) + '×') : p >= 1.05 ? c.yellow(p.toFixed(2) + '×') : c.green(p.toFixed(2) + '×')}`);
  }
  if (cy.end > now && cy.elapsed < 1) bits.push(`resets ${clock.short(cy.end)} (in ${duration(cy.end - now)})`);
  if (cy.pHit !== undefined) bits.push(`risk ${cy.pHit >= 0.5 ? c.red(pct(cy.pHit)) : cy.pHit >= 0.2 ? c.yellow(pct(cy.pHit)) : c.green(pct(cy.pHit))}`);
  if (cy.projected !== undefined) bits.push(`${cy.pHit !== undefined ? 'median' : 'projected'} at reset ${cy.projected >= 1 ? c.red(pct(cy.projected)) : pct(cy.projected)}`);
  if (cy.etaFull && cy.etaFull < cy.end) bits.push(c.red(`limit ≈ ${clock.short(cy.etaFull)} (${duration(cy.end - cy.etaFull)} early)`));
  bits.push(c.dim(`source: ${SOURCE_LABEL[cy.source]}`));
  lines.push('  ' + c.dim('↳ ') + bits.join(c.dim('  ·  ')));
  if (detailed) {
    const d: string[] = [`used ${money(cy.usedCost)} API-equiv.`];
    if (cy.limitCost) d.push(`100% ≈ ${money(cy.limitCost)}`);
    d.push(`burn now ${money(cy.burnPerHour)}/h`);
    if (cy.safeBurnPerHour !== undefined) d.push(`sustainable ≤ ${money(cy.safeBurnPerHour)}/h`);
    lines.push('  ' + c.dim('↳ ' + d.join('  ·  ')));
    for (const n of cy.notes) lines.push(c.dim(wordWrap('ⓘ ' + n, 2)));
  }
  return lines;
}

export function renderOverview(a: Analysis, cfg: Config): string {
  const clock = new Clock(a.timezone, cfg.weekStart);
  const m = a.metric;
  const out: string[] = [];
  out.push(c.bold('ccpulse') + c.dim(`  ·  ${clock.dateTime(a.generatedAt)} ${a.timezone}  ·  ${a.entries.toLocaleString()} requests indexed`));
  out.push('');
  const pv = a.planValue;
  out.push(
    `${c.bold('Plan')} ${a.plan.label}` +
      (pv.period ? c.dim(`  ·  billing day ${pv.period.day}/${pv.period.days}`) : '') +
      (pv.price ? c.dim(`  ·  value so far ${money(pv.valueSoFar)} = ${(pv.valueSoFar / pv.price).toFixed(1)}× the price`) : ''),
  );
  out.push('');
  out.push(c.bold('Cycles') + c.dim('  (risk = chance of hitting the limit before reset, from 2,000 simulations)'));
  for (const cy of a.cycles) out.push(...cycleLines(cy, clock, a.generatedAt, false));
  if (!a.official.available) out.push(c.dim(`  ⓘ plan meter unavailable: ${a.official.reason}`));
  out.push('');

  const f = a.forecast;
  out.push(c.bold('Usage & forecast') + c.dim(`  (${m === 'cost' ? 'API-equivalent USD' : 'tokens'})`));
  const rows = [f.today, f.week, f.month].map((p) => [
    p.label,
    val(p.actualSoFar, m),
    c.bold(val(p.value, m)),
    c.dim(`${val(p.lo, m)}–${val(p.hi, m)}`),
    p.previous !== undefined ? val(p.previous, m) : '-',
    signed(p.previous ? pctChange(p.value, p.previous) : undefined),
  ]);
  out.push(table(['', 'so far', 'forecast', '80% range', 'last time', 'Δ'], rows, ['l', 'r', 'r', 'r', 'r', 'r']));
  out.push('');

  const hv = a.series.hour.map((b) => metricOf(b, m));
  const max = Math.max(...hv, ...a.hourExpected);
  out.push(c.bold('Last 48h') + c.dim('  (each char = 1 hour; second line = your normal for that hour)'));
  out.push('  ' + sparkline(hv, max));
  out.push('  ' + c.dim(sparkline(a.hourExpected, max)));
  const dv = a.series.day.slice(-30).map((b) => metricOf(b, m));
  out.push(c.bold('Last 30 days') + '  ' + sparkline(dv) + c.dim(`  peak ${val(Math.max(...dv, 0), m)}`));
  out.push('');

  if (a.insights.length) {
    out.push(c.bold('Insights'));
    for (const i of a.insights.slice(0, 5)) {
      const mark = i.kind === 'warning' ? c.red('!') : i.kind === 'tip' ? c.green('➜') : i.kind === 'trend' ? c.cyan('↗') : c.blue('•');
      out.push(`  ${mark} ${i.title}`);
    }
    out.push('');
  }
  const recent = a.anomalies.filter((x) => x.end > a.generatedAt - 2 * 86_400_000).slice(0, 3);
  if (recent.length) {
    out.push(c.bold('Anomalies (48h)'));
    for (const an of recent) out.push(`  ${an.severity === 'extreme' ? c.red('▲') : c.yellow('▲')} ${an.label}\n${c.dim(wordWrap(an.explanation, 4))}`);
    out.push('');
  }
  if (a.api) {
    const m = a.api.month;
    out.push(`${c.bold('API spend')} ${money(m.spend)} this month → ${c.bold(money(m.projected))} ${c.dim(`forecast · ${a.api.budgets.filter((b) => b.status === 'critical' || b.status === 'warn').length} budget(s) at risk · ccpulse api`)}`);
    out.push('');
  } else if (a.apiError && a.plan.adminConfigured) out.push(c.yellow('⚠ ' + a.apiError) + '\n');
  for (const w of a.warnings) out.push(c.yellow('⚠ ' + w));
  out.push(c.dim('More: ccpulse pace | plan | analyze | api | report daily | forecast | anomalies | insights | dashboard | watch'));
  return out.join('\n');
}

export function renderPace(a: Analysis, cfg: Config): string {
  const clock = new Clock(a.timezone, cfg.weekStart);
  const out: string[] = [c.bold('Cycle pace') + c.dim('  (█ used, │ where an even pace would be now)'), ''];
  for (const cy of a.cycles) {
    out.push(...cycleLines(cy, clock, a.generatedAt, true));
    out.push('');
  }
  if (!a.official.available) out.push(c.dim(`Plan meter unavailable: ${a.official.reason}.`));
  for (const cal of a.calibration)
    if (Number.isFinite(cal.limitCost))
      out.push(c.dim(`Learned: 100% of ${cal.key} ≈ ${money(cal.limitCost)} API-equiv. (${cal.samples} readings, ±${pct(cal.spread / 2)})`));
  return out.join('\n');
}

export function renderReport(entries: Entry[], cfg: Config, g: Granularity, count: number, by?: 'model' | 'project'): string {
  const clock = new Clock(cfg.timezone, cfg.weekStart);
  const now = Date.now();
  const m = cfg.metric;
  let from = clock.bucketStart(now, g);
  for (let i = 1; i < count; i++) from = clock.bucketStart(from - 1, g);
  const buckets = bucketize(entries, clock, g, from, now + 1);
  const max = Math.max(...buckets.map((b) => metricOf(b, m)), 0);
  const rows = buckets.map((b, i) => {
    const prev = i ? metricOf(buckets[i - 1], m) : undefined;
    const v = metricOf(b, m);
    const barLen = max ? Math.round((v / max) * 20) : 0;
    return [
      b.label,
      b.requests.toLocaleString(),
      tokens(b.input),
      tokens(b.output),
      tokens(b.cacheWrite),
      tokens(b.cacheRead),
      tokens(b.tokens),
      money(b.cost),
      signed(prev ? pctChange(v, prev) : undefined),
      c.cyan('█'.repeat(barLen)),
    ];
  });
  const sum = buckets.reduce(
    (a, b) => ({ req: a.req + b.requests, i: a.i + b.input, o: a.o + b.output, cw: a.cw + b.cacheWrite, cr: a.cr + b.cacheRead, t: a.t + b.tokens, cost: a.cost + b.cost }),
    { req: 0, i: 0, o: 0, cw: 0, cr: 0, t: 0, cost: 0 },
  );
  rows.push(['Total', sum.req.toLocaleString(), tokens(sum.i), tokens(sum.o), tokens(sum.cw), tokens(sum.cr), tokens(sum.t), money(sum.cost), '', ''].map((x) => c.bold(x)));
  const title = { hour: 'Hourly', day: 'Daily', week: 'Weekly', month: 'Monthly' }[g];
  let s = c.bold(`${title} usage`) + c.dim(`  · ${clock.tz}`) + '\n\n';
  s += table(['Period', 'Req', 'Input', 'Output', 'Cache W', 'Cache R', 'Tokens', 'Cost', 'Δ', ''], rows, ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l']);
  if (by) {
    const grp = [...groupBy(entries, (e) => (by === 'model' ? e.model : e.project), from, now + 1)].sort((x, y) => y[1].cost - x[1].cost);
    const total = grp.reduce((a, [, t]) => a + metricOf(t, m), 0) || 1;
    s += '\n\n' + c.bold(`By ${by}`) + '\n';
    s += table(
      [by === 'model' ? 'Model' : 'Project', 'Req', 'Tokens', 'Cost', 'Share'],
      grp.slice(0, 25).map(([k, t]) => [k, t.requests.toLocaleString(), tokens(t.tokens), money(t.cost), pct(metricOf(t, m) / total)]),
      ['l', 'r', 'r', 'r', 'r'],
    );
  }
  return s;
}

export function renderForecast(a: Analysis): string {
  const f = a.forecast;
  const m = a.metric;
  const out: string[] = [c.bold('Forecast') + c.dim(`  · ${f.model}`), ''];
  out.push(
    table(
      ['Period', 'so far', 'forecast', '80% range', 'previous', 'Δ'],
      [f.today, f.week, f.month, f.nextMonth].map((p) => [
        p.label,
        val(p.actualSoFar, m),
        c.bold(val(p.value, m)),
        c.dim(`${val(p.lo, m)}–${val(p.hi, m)}`),
        p.previous !== undefined ? val(p.previous, m) : '-',
        signed(p.previous ? pctChange(p.value, p.previous) : undefined),
      ]),
      ['l', 'r', 'r', 'r', 'r', 'r'],
    ),
  );
  out.push('');
  out.push(c.bold('Next 7 days'));
  const max = Math.max(...f.next7.map((p) => p.hi), 0);
  out.push(
    table(
      ['Day', 'forecast', 'range', ''],
      f.next7.map((p) => [p.label, val(p.value, m), c.dim(`${val(p.lo, m)}–${val(p.hi, m)}`), c.cyan('█'.repeat(max ? Math.round((p.value / max) * 24) : 0))]),
      ['l', 'r', 'r', 'l'],
    ),
  );
  out.push('');
  const t = f.weeklyTrend;
  out.push(
    `Weekly trend: ${t.slopePct >= 0 ? '+' : ''}${(t.slopePct * 100).toFixed(1)}%/week` +
      c.dim(` (R² ${t.r2.toFixed(2)}, ${t.weeks} weeks${t.r2 < 0.3 ? ', weak signal' : ''})`),
  );
  out.push(
    `Backtest accuracy: ${Number.isFinite(f.accuracy.wape) ? `${Math.round(f.accuracy.wape * 100)}% avg. daily error` : 'not enough history'}` +
      c.dim(Number.isFinite(f.accuracy.coverage) ? `, ${Math.round(f.accuracy.coverage * 100)}% of days fell inside the 80% range (last ${f.accuracy.days} days)` : ''),
  );
  return out.join('\n');
}

export function renderAnomalies(a: Analysis): string {
  if (!a.anomalies.length) return c.green('No anomalies in the lookback window.') + c.dim(' (Compared with your own hour-of-day and daily history.)');
  const rows = a.anomalies.map((an) => [
    an.severity === 'extreme' ? c.red(an.severity) : an.severity === 'high' ? c.yellow(an.severity) : an.severity,
    an.kind,
    an.label,
    val(an.value, a.metric),
    val(an.typical, a.metric),
    Number.isFinite(an.ratio) ? `${an.ratio.toFixed(1)}×` : '∞',
    an.drivers
      .filter((d) => d.project || d.model)
      .map((d) => `${d.project ?? d.model} ${pct(d.share)}`)
      .join(', '),
  ]);
  return c.bold('Anomalies') + c.dim('  (ratio = value ÷ your usual busy level)') + '\n\n' + table(['Severity', 'Kind', 'When', 'Value', 'Typical', 'Ratio', 'Drivers'], rows, ['l', 'l', 'l', 'r', 'r', 'r', 'l']);
}

export function renderInsights(a: Analysis, cfg: Config): string {
  const out: string[] = [c.bold('What your usage says'), ''];
  for (const i of a.insights) {
    const mark = i.kind === 'warning' ? c.red('!') : i.kind === 'tip' ? c.green('➜') : i.kind === 'trend' ? c.cyan('↗') : c.blue('•');
    out.push(`${mark} ${c.bold(i.title)}`);
    out.push(c.dim(wordWrap(i.detail, 2)));
  }
  const h = a.habits;
  out.push('');
  out.push(c.bold('Typical week') + c.dim('  (rows = weekdays, columns = hours 00→23)'));
  const max = Math.max(...h.heatmap.flat(), 0);
  const days = cfg.weekStart === 'sunday' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const shades = [' ', '░', '▒', '▓', '█'];
  for (let w = 0; w < 7; w++) {
    out.push(`  ${days[w]} ` + h.heatmap[w].map((v) => (v <= 0 ? c.gray('·') : c.cyan(shades[Math.min(4, 1 + Math.floor((v / max) * 3.999))]))).join(''));
  }
  out.push('      ' + c.dim('0     6     12    18   23'));
  return out.join('\n');
}

export function renderStatusline(a: Analysis): string {
  const parts: string[] = [];
  for (const cy of a.cycles) {
    const name = cy.key === 'five_hour' ? '5h' : cy.key === 'seven_day' ? 'wk' : cy.key.replace('seven_day_', 'wk-');
    if (cy.used === undefined || cy.source === 'history') {
      // No real limit: show spend, not a made-up percentage.
      if (cy.usedCost > 0) parts.push(c.dim(`${name} `) + money(cy.usedCost));
      continue;
    }
    const p = cy.pace !== undefined && cy.elapsed >= 0.05 ? ` ${cy.pace.toFixed(1)}×` : '';
    const col = cy.status === 'critical' ? c.red : cy.status === 'warn' ? c.yellow : c.green;
    parts.push(col(`${name} ${pct(cy.used)}${p}`) + c.dim(`@${pct(cy.elapsed)}`));
  }
  const f = a.forecast.today;
  parts.push(`today ${money(a.totals.today.cost)}${c.dim(`→${money(f.value)}`)}`);
  const recent = a.anomalies.find((x) => x.end > a.generatedAt - 2 * 3_600_000);
  if (recent) parts.push(c.red('▲ spike'));
  return parts.join(c.dim(' │ '));
}

