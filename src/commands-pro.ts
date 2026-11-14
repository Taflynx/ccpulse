import type { ApiKeyInfo, RateLimitInfo, SpendLimitInfo, WorkspaceInfo } from './admin.js';
import type { Analysis } from './analysis.js';
import type { ApiReport } from './analytics/api.js';
import type { Config } from './config.js';
import { c, money, paceBar, pct, signed, sparkline, table, tokens, wordWrap } from './render/term.js';
import { Clock, duration } from './time.js';

const pctOrDash = (v: number | undefined, d = 0) => pct(v, d);
const shareBar = (v: number, width = 20) => c.cyan('█'.repeat(Math.max(0, Math.round(v * width)))) + c.gray('░'.repeat(Math.max(0, width - Math.round(v * width))));

// ---------------------------------------------------------------------------------------------
// ccpulse plan
// ---------------------------------------------------------------------------------------------

export function renderPlan(a: Analysis, cfg: Config): string {
  const clock = new Clock(a.timezone, cfg.weekStart);
  const p = a.plan;
  const v = a.planValue;
  const out: string[] = [c.bold('Your plan'), ''];
  const auth = Object.entries(p.auth)
    .filter(([, on]) => on)
    .map(([k]) => ({ oauth: 'Claude login', apiKeyEnv: 'API key in env', apiKeyHelper: 'apiKeyHelper', bedrock: 'Bedrock', vertex: 'Vertex', foundry: 'Foundry', customBaseUrl: 'custom base URL' })[k as 'oauth']);
  const rows: [string, string][] = [
    ['Plan', c.bold(p.label) + (p.formerly ? c.dim(`  (formerly ${p.formerly})`) : '')],
    ['Weekly allowance', p.multiplier ? `${p.multiplier}× Pro` : '-'],
    ['5-hour limit', p.noSessionLimit ? c.green('none (verified accounts)') : p.sessionMultiplier ? `${p.sessionMultiplier}× Pro` : '-'],
    ['Fable', p.fableWeeklyShare ? `included, up to ${Math.round(p.fableWeeklyShare * 100)}% of the weekly limit` : p.kind === 'pro' ? 'paid with usage credits' : '-'],
    ['API credits', p.apiCredits ? `$${p.apiCredits}/month on the Claude Platform ${c.dim('(not usable in Claude Code)')}` : '-'],
    ['Rate-limit tier', p.rateLimitTier ?? '-'],
    ['Billing', p.billingType ? p.billingType.replace(/_/g, ' ') : '-'],
    ['Extra usage', p.extraUsage === undefined ? '-' : p.extraUsage ? c.yellow('on (overage is billed)') : 'off'],
    ['Price used', p.monthlyPrice !== undefined ? `${money(p.monthlyPrice)}/month ${c.dim(p.priceSource === 'config' ? '(your config)' : `(list price, catalog ${p.catalogAsOf})`)}` : c.dim('unknown, set plan.monthlyPrice')],
    ['Auth in use', auth.join(', ') || '-'],
    ['Org API analytics', p.adminConfigured ? c.green('Admin API key configured') : c.dim('not configured (CCPULSE_ADMIN_KEY)')],
  ];
  if (p.subscriptionStartedAt) rows.splice(3, 0, ['Subscribed since', clock.dateTime(p.subscriptionStartedAt).slice(0, 10)]);
  for (const [k, val] of rows) out.push(`  ${c.dim(k.padEnd(18))} ${val}`);
  out.push('');

  if (v.period) {
    out.push(c.bold('Billing cycle'));
    out.push(`  ${paceBar(v.period.elapsed, v.period.elapsed)}  day ${v.period.day} of ${v.period.days}  ${c.dim(`(${clock.dateTime(v.period.start).slice(0, 10)} → ${clock.dateTime(v.period.end).slice(0, 10)}, renews in ${duration(v.period.end - a.generatedAt)})`)}`);
    out.push('');
  }
  out.push(c.bold('Value this cycle') + c.dim('  (API-equivalent cost of your Claude Code usage on this machine)'));
  const vr: string[][] = [['So far', money(v.valueSoFar), v.price ? `${(v.valueSoFar / v.price).toFixed(1)}× the price` : '']];
  vr.push(['Projected at renewal', c.bold(money(v.valueProjected)), v.multiple ? c.bold(`${v.multiple.toFixed(1)}× the price`) : '']);
  for (const h of v.history) vr.push([c.dim(`Cycle from ${clock.dateTime(h.start).slice(0, 10)}`), c.dim(money(h.value)), v.price ? c.dim(`${(h.value / v.price).toFixed(1)}×`) : '']);
  out.push(table(['', 'value', 'vs. price'], vr, ['l', 'r', 'r']));
  out.push('');
  const adv = a.planAdvice;
  const mark = adv.verdict === 'upgrade' ? c.red('▲') : adv.verdict === 'downgrade' ? c.green('▼') : adv.verdict === 'fits' ? c.green('✓') : c.yellow('?');
  out.push(c.bold('Advice'));
  out.push(`  ${mark} ${c.bold(adv.title)}`);
  out.push(c.dim(wordWrap(adv.detail, 4)));
  for (const n of p.notes) out.push(c.dim(wordWrap('ⓘ ' + n, 2)));
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// ccpulse analyze
// ---------------------------------------------------------------------------------------------

export function renderAnalyze(a: Analysis, cfg: Config): string {
  const clock = new Clock(a.timezone, cfg.weekStart);
  const x = a.advanced;
  const out: string[] = [c.bold('Deep analysis') + c.dim(`  · last ${x.window.days} days · API-equivalent USD`), ''];

  // Risk
  if (a.risks.length) {
    out.push(c.bold('Limit risk') + c.dim('  (Monte Carlo, 2,000 simulated futures from your own history)'));
    out.push(
      table(
        ['Window', 'used', 'P(hit before reset)', 'at reset: p10', 'p50', 'p90', 'likely limit'],
        a.risks.map((r) => {
          const cy = a.cycles.find((k) => k.key === r.key)!;
          const p = r.pHit >= 0.5 ? c.red(pct(r.pHit)) : r.pHit >= 0.2 ? c.yellow(pct(r.pHit)) : c.green(pct(r.pHit));
          return [cy.label, pct(cy.used), p, pct(r.p10), pct(r.p50), pct(r.p90), r.pHit >= 0.5 && r.etaP50 ? clock.short(r.etaP50) : c.dim('-')];
        }),
        ['l', 'r', 'r', 'r', 'r', 'r', 'l'],
      ),
    );
    out.push('');
  }

  // Cost anatomy
  const an = x.anatomy;
  const parts: [string, number][] = [
    ['Output (incl. thinking)', an.output],
    ['  of which thinking', an.thinking],
    ['Cache reads', an.cacheRead],
    ['Cache writes (1h)', an.cacheWrite1h],
    ['Cache writes (5m)', an.cacheWrite5m],
    ['Uncached input', an.input],
  ];
  out.push(c.bold('Where the cost goes'));
  out.push(
    table(
      ['', 'cost', 'share', ''],
      parts.map(([k, v]) => [k.startsWith('  ') ? c.dim(k) : k, money(v), pct(an.total ? v / an.total : 0), shareBar(an.total ? v / an.total : 0)]),
      ['l', 'r', 'r', 'l'],
    ),
  );
  out.push(c.dim(`  Total ${money(an.total)}. Without prompt caching the same work would cost ~${money(an.withoutCache)} (${an.total ? (an.withoutCache / an.total).toFixed(1) : '-'}×).`));
  out.push('');

  // Context economics
  const ce = x.context;
  out.push(c.bold('Context economics'));
  const ctx: [string, string][] = [
    ['Prompt size per request', `p50 ${tokens(ce.promptP50)} · p90 ${tokens(ce.promptP90)} · p99 ${tokens(ce.promptP99)}`],
    ['Context growth', `~${tokens(ce.growthPerTurn)} tokens per turn within a session`],
    ['Cache hit rate', `${pct(ce.cacheHitRate)} · each cached token re-read ${ce.cacheReuse.toFixed(0)}×`],
    ['Requests over 200k context', `${pct(ce.over200kShare, 1)} of requests · ${pct(ce.over200kCostShare)} of cost`],
    ['Context above 100k re-read', `${money(ce.heavyContextCost)}: what earlier /compact or /clear could have saved`],
    ['Thinking share of output', pct(ce.thinkingShareOfOutput)],
  ];
  for (const [k, v] of ctx) out.push(`  ${c.dim(k.padEnd(28))} ${v}`);
  out.push('');

  // Sessions
  const s = x.sessions;
  out.push(c.bold('Sessions'));
  out.push(
    `  ${s.count} working sessions · median ${duration(s.durationP50)} long (p90 ${duration(s.durationP90)}) · median ${money(s.costP50)} (p90 ${money(s.costP90)}, max ${money(s.costMax)}) · ${s.requestsP50.toFixed(0)} requests`,
  );
  out.push(`  ${c.dim('Subagents carry')} ${pct(s.subagentCostShare)} ${c.dim('of cost ·')} ${s.oneShot.toLocaleString()} ${c.dim('one-shot sessions (automations) carry')} ${pct(s.oneShotCostShare)}`);
  out.push(
    table(
      ['Most expensive', 'project', 'started', 'length', 'requests', 'cost'],
      s.top.slice(0, 5).map((t) => [t.model, t.project, clock.dateTime(t.start), duration(t.end - t.start), String(t.requests), money(t.cost)]),
      ['l', 'l', 'l', 'r', 'r', 'r'],
    ),
  );
  out.push('');

  // Breakdowns
  const bd = (title: string, rows: Analysis['advanced']['byEffort']) =>
    rows.length
      ? [
          c.bold(title),
          table(
            ['', 'share', 'requests', 'cost/request', ''],
            rows.slice(0, 6).map((b) => [b.key, pct(b.share), b.totals.requests.toLocaleString(), money(b.costPerRequest), shareBar(b.share, 16)]),
            ['l', 'r', 'r', 'r', 'l'],
          ),
          '',
        ]
      : [];
  out.push(...bd('By effort level', x.byEffort));
  out.push(...bd('Main thread vs. subagents', x.bySubagent));
  out.push(...bd('By entry point', x.byEntrypoint));

  // Model mix trend
  if (x.mix.points.length) {
    out.push(c.bold('Model mix by week') + c.dim('  (share of usage weight)'));
    const pts = x.mix.points.slice(-8);
    out.push(
      table(
        ['Week', ...x.mix.models.map((m) => m.replace('claude-', ''))],
        pts.map((p) => [p.label.replace('wk of ', ''), ...x.mix.models.map((m) => (p.shares[m] ? pct(p.shares[m]) : c.dim('-')))]),
        ['l', ...x.mix.models.map(() => 'r' as const)],
      ),
    );
    out.push('');
  }

  // Concentration + change point
  const k = x.concentration;
  out.push(c.bold('Concentration'));
  out.push(
    `  Top project ${pct(k.topShare)} · top 3 ${pct(k.top3Share)} · HHI ${k.hhi.toFixed(2)} ${c.dim(`(≈ ${k.effectiveProjects.toFixed(1)} equally-sized projects)`)}`,
  );
  if (a.changePoint) {
    const cp = a.changePoint;
    out.push('');
    out.push(c.bold('Regime change detected'));
    out.push(
      `  Since ${cp.label}: typical day ${money(cp.before)} → ${money(cp.after)} ${signed(cp.change)} ${c.dim(`(t = ${cp.strength.toFixed(1)}, log-scale level shift)`)}`,
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// ccpulse api …
// ---------------------------------------------------------------------------------------------

export function renderApiReport(r: ApiReport, tz: string): string {
  const clock = new Clock(tz);
  const m = r.month;
  const out: string[] = [];
  out.push(c.bold(`API spend · ${r.organization.name}`) + c.dim(`  · ${clock.dateTime(m.start).slice(0, 7)} · USD`));
  out.push('');
  out.push(`  ${paceBar(m.projected ? m.spend / m.projected : 0, m.elapsed)}  ${c.bold(money(m.spend))} so far · ${pct(m.elapsed)} of the month`);
  out.push(
    `  ${c.dim('↳')} forecast ${c.bold(money(m.projected))} ${c.dim(`(80%: ${money(m.lo)}–${money(m.hi)})`)} · last month ${money(m.lastMonth)} · same point last month ${money(m.lastMonthToDate)} ${signed(m.lastMonthToDate ? m.spend / m.lastMonthToDate - 1 : undefined)}`,
  );
  if (m.listSpend > m.spend * 1.01) out.push(`  ${c.dim('↳')} list-price value ${money(m.listSpend)}: discounts saved ${money(m.listSpend - m.spend)}`);
  out.push(`  ${c.dim('Last 60 days')} ${sparkline(r.daily.map((d) => d.usd))}  ${c.dim(`forecast model α=${r.forecast.alpha}, ${Math.round(r.forecast.wape * 100)}% avg daily error`)}`);
  out.push('');
  if (r.budgets.length) {
    out.push(c.bold('Budgets') + c.dim('  (│ = where an even pace would be)'));
    for (const b of r.budgets) {
      const st = b.status === 'critical' ? c.red('● over') : b.status === 'warn' ? c.yellow('● fast') : b.status === 'watch' ? c.yellow('○ watch') : c.green('● ok');
      out.push(`  ${b.name.padEnd(14)} ${paceBar(b.used, b.elapsed, 24)} ${money(b.spend).padStart(7)} / ${money(b.monthly)}  pace ${b.pace.toFixed(2)}×  → ${money(b.projected)}  ${st}`);
    }
    out.push('');
  }
  const grp = (title: string, rows: ApiReport['byWorkspace'], n = 6) => [
    c.bold(title),
    table(
      ['', 'this month', 'share', 'last 7d', 'vs prior 7d', ''],
      rows.slice(0, n).map((g) => [g.name, money(g.monthToDate), pct(g.share), money(g.last7), signed(g.prev7 ? g.last7 / g.prev7 - 1 : undefined), shareBar(g.share, 14)]),
      ['l', 'r', 'r', 'r', 'r', 'l'],
    ),
    '',
  ];
  out.push(...grp('By workspace', r.byWorkspace));
  out.push(...grp('By API key', r.byKey));
  out.push(...grp('By model', r.byModel));
  if (r.anomalies.length) {
    out.push(c.bold('Anomalies'));
    for (const an of r.anomalies.slice(0, 6))
      out.push(`  ${c.yellow('▲')} ${clock.dateTime(an.t).slice(0, 10)}  ${money(an.usd)} vs typical ${money(an.typical)} (${Number.isFinite(an.ratio) ? an.ratio.toFixed(1) + '×' : '∞'} busy)  ${c.dim(an.driver)}`);
    out.push('');
  }
  if (r.hygiene.length) {
    out.push(c.bold('Recommendations'));
    for (const h of r.hygiene) {
      out.push(`  ${h.level === 'warn' ? c.yellow('!') : c.blue('•')} ${h.title}`);
      out.push(c.dim(wordWrap(h.detail, 4)));
    }
    out.push('');
  }
  if (r.spendLimits.length)
    out.push(c.dim(`Spend limits: ${r.spendLimits.map((s) => `${s.scope} ${s.amount ? money(s.amount) : 'none'}/${s.period}${s.enabled ? '' : ' (disabled)'}`).join(' · ')}`));
  for (const n of r.notes) out.push(c.dim('ⓘ ' + n));
  return out.join('\n');
}

export function renderKeys(keys: ApiKeyInfo[], r: ApiReport | undefined, tz: string): string {
  const clock = new Clock(tz);
  const rows = keys
    .sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === 'active' ? -1 : 1))
    .map((k) => {
      const g = r?.byKey.find((x) => x.id === k.id);
      const st = k.status === 'active' ? c.green(k.status) : k.status === 'inactive' ? c.yellow(k.status) : c.gray(k.status);
      return [
        k.name,
        c.dim(k.id),
        st,
        k.hint ?? '',
        clock.dateTime(k.createdAt).slice(0, 10),
        k.expiresAt ? clock.dateTime(k.expiresAt).slice(0, 10) : c.dim('never'),
        g ? money(g.monthToDate) : c.dim('-'),
        g?.lastUsed ? clock.dateTime(g.lastUsed).slice(0, 10) : c.dim('-'),
      ];
    });
  return (
    c.bold('API keys') +
    '\n\n' +
    table(['Name', 'ID', 'Status', 'Hint', 'Created', 'Expires', 'This month', 'Last used'], rows, ['l', 'l', 'l', 'l', 'l', 'l', 'r', 'l']) +
    '\n\n' +
    c.dim('Manage: ccpulse api keys disable|enable|archive <id>   ·   ccpulse api keys rename <id> "<name>"')
  );
}

export function renderWorkspaces(ws: WorkspaceInfo[], r: ApiReport | undefined, tz: string): string {
  const clock = new Clock(tz);
  return (
    c.bold('Workspaces') +
    '\n\n' +
    table(
      ['Name', 'ID', 'Created', 'This month', 'Share'],
      ws.map((w) => {
        const g = r?.byWorkspace.find((x) => x.id === w.id);
        return [w.name, c.dim(w.id), clock.dateTime(w.createdAt).slice(0, 10), g ? money(g.monthToDate) : c.dim('-'), g ? pct(g.share) : c.dim('-')];
      }),
      ['l', 'l', 'l', 'r', 'r'],
    )
  );
}

export function renderRateLimits(rl: RateLimitInfo[]): string {
  return (
    c.bold('Rate limits') +
    '\n\n' +
    table(
      ['Group', 'Limit', 'Value'],
      rl.flatMap((g) => g.limits.map((l, i) => [i ? '' : g.group, l.type.replace(/_/g, ' '), l.value.toLocaleString()])),
      ['l', 'l', 'r'],
    )
  );
}

export function renderSpendLimits(sl: SpendLimitInfo[]): string {
  if (!sl.length) return c.dim('No spend limits set. Set one with: ccpulse api spend-limits set org 2000 --period monthly');
  return (
    c.bold('Spend limits') +
    '\n\n' +
    table(['Scope', 'Amount', 'Period', 'Enabled', 'ID'], sl.map((s) => [s.scope, s.amount !== undefined ? money(s.amount) : 'none', s.period, s.enabled ? 'yes' : 'no', c.dim(s.id)]), ['l', 'r', 'l', 'l', 'l'])
  );
}

export { pctOrDash };
