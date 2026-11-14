import type { AdminApi, ApiKeyInfo, CostRow, SpendLimitInfo, UsageRow, WorkspaceInfo } from '../admin.js';
import type { Config } from '../config.js';
import { median, quantile } from '../stats.js';
import { learnSeries, predictDay, type DayPoint } from './forecast.js';

/** Organization API spend: what it is, where it goes, where it's heading, what to fix. */
export interface ApiReport {
  organization: { id: string; name: string };
  demo: boolean;
  generatedAt: number;
  month: {
    start: number;
    end: number;
    elapsed: number;
    spend: number;
    projected: number;
    lo: number;
    hi: number;
    lastMonth: number;
    /** Spend at the same point last month. */
    lastMonthToDate: number;
    /** List-price value of the same traffic (batch and other discounts make spend lower). */
    listSpend: number;
  };
  /** UTC days, oldest first. */
  daily: { t: number; usd: number }[];
  next7: { t: number; usd: number; lo: number; hi: number }[];
  forecast: { alpha: number; wape: number; coverage: number };
  byWorkspace: Group[];
  byKey: (Group & { status?: string; lastUsed?: number; hint?: string })[];
  byModel: Group[];
  byProduct: Group[];
  budgets: BudgetStatus[];
  anomalies: { t: number; usd: number; typical: number; ratio: number; driver: string }[];
  hygiene: { level: 'info' | 'warn'; title: string; detail: string }[];
  cache: { model: string; hitRate: number; requests: number }[];
  spendLimits: SpendLimitInfo[];
  notes: string[];
}

export interface Group {
  id: string;
  name: string;
  monthToDate: number;
  last7: number;
  prev7: number;
  share: number;
}

export interface BudgetStatus {
  name: string;
  monthly: number;
  spend: number;
  projected: number;
  used: number;
  elapsed: number;
  pace: number;
  status: 'ok' | 'watch' | 'warn' | 'critical';
}

const DAY = 86_400_000;
const utcDay = (t: number) => Math.floor(t / DAY) * DAY;
const monthStart = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
const nextMonth = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

function group(rows: CostRow[], key: (r: CostRow) => string | null, names: Map<string, string>, mStart: number, now: number, total: number): Group[] {
  const today = utcDay(now);
  const m = new Map<string, Group>();
  for (const r of rows) {
    const id = key(r) ?? '(none)';
    let g = m.get(id);
    if (!g) m.set(id, (g = { id, name: names.get(id) ?? id, monthToDate: 0, last7: 0, prev7: 0, share: 0 }));
    if (r.t >= mStart) g.monthToDate += r.usd;
    if (r.t >= today - 7 * DAY) g.last7 += r.usd;
    else if (r.t >= today - 14 * DAY) g.prev7 += r.usd;
  }
  for (const g of m.values()) g.share = total ? g.monthToDate / total : 0;
  return [...m.values()].filter((g) => g.monthToDate > 0 || g.last7 > 0).sort((a, b) => b.monthToDate - a.monthToDate);
}

export async function apiReport(admin: AdminApi, cfg: Config, now = Date.now()): Promise<ApiReport> {
  const [organization, cost, usage, keys, workspaces, spendLimits] = await Promise.all([
    admin.organization(),
    admin.cost(70),
    admin.usage(35).catch(() => [] as UsageRow[]),
    admin.apiKeys().catch(() => [] as ApiKeyInfo[]),
    admin.workspaces().catch(() => [] as WorkspaceInfo[]),
    admin.spendLimits().catch(() => [] as SpendLimitInfo[]),
  ]);
  const notes: string[] = ['Anthropic refreshes usage and cost data within ~4 hours (up to 24 h). Today is partial.'];
  const mStart = monthStart(now);
  const mEnd = nextMonth(now);
  const today = utcDay(now);

  // Daily series (UTC) with zero-filled gaps.
  const byDay = new Map<number, number>();
  for (const r of cost) byDay.set(utcDay(r.t), (byDay.get(utcDay(r.t)) ?? 0) + r.usd);
  const first = Math.min(...cost.map((r) => r.t), today);
  const daily: ApiReport['daily'] = [];
  for (let d = utcDay(first); d <= today; d += DAY) daily.push({ t: d, usd: byDay.get(d) ?? 0 });
  const complete: DayPoint[] = daily.filter((d) => d.t < today).map((d) => ({ start: d.t, label: '', wi: (new Date(d.t).getUTCDay() + 6) % 7, value: d.usd }));
  const learned = learnSeries(complete);
  const band = (v: number) => ({ lo: v * Math.min(1, learned.qlo), hi: v * Math.max(1, learned.qhi) });

  const spend = cost.filter((r) => r.t >= mStart).reduce((a, r) => a + r.usd, 0);
  const listSpend = cost.filter((r) => r.t >= mStart).reduce((a, r) => a + r.listUsd, 0);
  // Today is partial upstream: count the rest of today + remaining days as forecast.
  const todayActual = byDay.get(today) ?? 0;
  const todayPred = predictDay(complete, (new Date(today).getUTCDay() + 6) % 7, learned.alpha);
  const hourShare = (now - today) / DAY;
  let projected = spend + Math.max(0, todayPred - todayActual) * (1 - Math.min(1, hourShare));
  let lo = projected;
  let hi = projected;
  const next7: ApiReport['next7'] = [];
  for (let d = today + DAY; d < Math.max(mEnd, today + 8 * DAY); d += DAY) {
    const v = predictDay(complete, (new Date(d).getUTCDay() + 6) % 7, learned.alpha);
    if (d < mEnd) {
      projected += v;
      lo += band(v).lo;
      hi += band(v).hi;
    }
    if (next7.length < 7) next7.push({ t: d, usd: v, ...band(v) });
  }
  const lastStart = monthStart(mStart - DAY);
  const lastMonth = cost.filter((r) => r.t >= lastStart && r.t < mStart).reduce((a, r) => a + r.usd, 0);
  const lastMonthToDate = cost.filter((r) => r.t >= lastStart && r.t < lastStart + (now - mStart)).reduce((a, r) => a + r.usd, 0);
  if (lastStart < first) notes.push('Less than two months of history: last-month comparisons are partial.');

  const wsNames = new Map(workspaces.map((w) => [w.id, w.name] as [string, string]));
  wsNames.set('(none)', 'Default workspace');
  const keyNames = new Map(keys.map((k) => [k.id, k.name] as [string, string]));
  keyNames.set('(none)', 'No key (Console / WIF)');
  const byKey = group(cost, (r) => r.apiKeyId, keyNames, mStart, now, spend).map((g) => {
    const k = keys.find((x) => x.id === g.id);
    const used = cost.filter((r) => r.apiKeyId === g.id && r.usd > 0).map((r) => r.t);
    return { ...g, status: k?.status, hint: k?.hint, lastUsed: used.length ? Math.max(...used) : undefined };
  });

  // Budgets: same pace logic as plan cycles, on the calendar month.
  const elapsed = (now - mStart) / (mEnd - mStart);
  const budgets: BudgetStatus[] = cfg.api.budgets.map((b) => {
    const match = (r: CostRow) =>
      (!b.workspaceId || r.workspaceId === b.workspaceId) && (!b.apiKeyId || r.apiKeyId === b.apiKeyId) && (!b.model || (r.model ?? '').includes(b.model));
    const s = cost.filter((r) => r.t >= mStart && match(r)).reduce((a, r) => a + r.usd, 0);
    const shareOfAll = spend ? s / spend : 0;
    const proj = s + (projected - spend) * shareOfAll;
    const used = s / b.monthly;
    const pace = elapsed > 0.02 ? used / elapsed : 0;
    const status: BudgetStatus['status'] = proj >= b.monthly || used >= 0.9 ? 'critical' : pace >= cfg.alerts.pace || used >= 0.75 ? 'warn' : pace >= 1.05 ? 'watch' : 'ok';
    return { name: b.name, monthly: b.monthly, spend: s, projected: proj, used, elapsed, pace, status };
  });

  // Anomalies: last 14 days vs. the 56 before, robust quantile score, with the top key as driver.
  const anomalies: ApiReport['anomalies'] = [];
  for (const d of daily.filter((x) => x.t >= today - 14 * DAY && x.t < today)) {
    const hist = daily.filter((x) => x.t < d.t && x.t >= d.t - 56 * DAY).map((x) => x.usd);
    if (hist.length < 14) continue;
    const p50 = median(hist);
    const p90 = quantile(hist, 0.9);
    const score = (d.usd - p50) / Math.max(p90 - p50, 1);
    if (score < 3 || d.usd < 5) continue;
    const day = cost.filter((r) => utcDay(r.t) === d.t);
    const top = [...group(day, (r) => r.apiKeyId, keyNames, 0, now, 0)].sort((a, b) => b.monthToDate - a.monthToDate)[0];
    anomalies.push({ t: d.t, usd: d.usd, typical: p50, ratio: p90 ? d.usd / p90 : Infinity, driver: top ? `${top.name} (${Math.round((top.monthToDate / d.usd) * 100)}%)` : '' });
  }
  // Per-key bursts: a key spending far above its own recent norm.
  for (const k of byKey) {
    const series = daily.map((d) => cost.filter((r) => r.apiKeyId === k.id && utcDay(r.t) === d.t).reduce((a, r) => a + r.usd, 0));
    const recent = series.slice(-4, -1);
    const base = series.slice(-32, -4);
    if (base.length < 14) continue;
    const p90 = quantile(base, 0.9);
    const peak = Math.max(...recent);
    if (peak > Math.max(p90 * 2.5, 5))
      anomalies.push({ t: today - (3 - recent.indexOf(peak)) * DAY, usd: peak, typical: median(base), ratio: p90 ? peak / p90 : Infinity, driver: `key ${k.name}` });
  }
  anomalies.sort((a, b) => b.t - a.t);

  // Hygiene: unused, unexpiring, expiring-soon keys.
  const hygiene: ApiReport['hygiene'] = [];
  for (const k of keys.filter((x) => x.status === 'active')) {
    const g = byKey.find((x) => x.id === k.id);
    if (!g || !g.lastUsed || g.lastUsed < today - 30 * DAY)
      hygiene.push({ level: 'warn', title: `Active key unused for 30+ days: ${k.name}`, detail: `Disable it with \`ccpulse api keys disable ${k.id}\` to shrink your attack surface.` });
    if (k.expiresAt && k.expiresAt - now < 14 * DAY && k.expiresAt > now)
      hygiene.push({ level: 'warn', title: `Key expires in ${Math.ceil((k.expiresAt - now) / DAY)} days: ${k.name}`, detail: 'Rotate it before the expiry date to avoid an outage.' });
    if (!k.expiresAt && now - k.createdAt > 180 * DAY)
      hygiene.push({ level: 'info', title: `Key older than 6 months without expiry: ${k.name}`, detail: 'Consider rotating long-lived keys and setting an expiration.' });
  }
  if (byKey[0] && byKey[0].share > 0.6 && byKey.length > 1)
    hygiene.push({ level: 'info', title: `${Math.round(byKey[0].share * 100)}% of spend is on one key (${byKey[0].name})`, detail: 'A dedicated workspace with its own spend limit contains the blast radius of a bug or leak.' });
  if (listSpend > spend * 1.05)
    hygiene.push({ level: 'info', title: `Discounts saved $${(listSpend - spend).toFixed(0)} this month`, detail: 'Batch API and other discounts. Move more offline work to batches to save more.' });

  for (const l of spendLimits.filter((x) => x.enabled && x.amount && x.period === 'monthly' && x.scope === 'organization')) {
    if (projected >= l.amount! * 0.95)
      hygiene.unshift({
        level: 'warn',
        title: `Projected month-end spend $${projected.toFixed(0)} is ${projected >= l.amount! ? 'over' : 'near'} the $${l.amount!.toFixed(0)} organization spend limit`,
        detail: 'Requests start failing when the limit is reached. Raise it, or find the driver below.',
      });
  }

  // Prompt-cache efficiency per model (input side).
  const cacheMap = new Map<string, { read: number; prompt: number; requests: number }>();
  for (const u of usage) {
    const m = u.model ?? 'other';
    let c = cacheMap.get(m);
    if (!c) cacheMap.set(m, (c = { read: 0, prompt: 0, requests: 0 }));
    c.read += u.cacheRead;
    c.prompt += u.cacheRead + u.cacheWrite + u.uncachedInput;
    c.requests += u.requests;
  }
  const cache = [...cacheMap].map(([model, c]) => ({ model, hitRate: c.prompt ? c.read / c.prompt : 0, requests: c.requests })).sort((a, b) => b.requests - a.requests);
  for (const c of cache)
    if (c.hitRate < 0.3 && c.requests > 1000)
      hygiene.push({ level: 'info', title: `Low prompt-cache hit rate on ${c.model}: ${Math.round(c.hitRate * 100)}%`, detail: 'Stable system prompts and tools with cache_control breakpoints usually cut input cost by 50–90%.' });

  return {
    organization,
    demo: admin.demo,
    generatedAt: now,
    month: { start: mStart, end: mEnd, elapsed, spend, projected, lo, hi, lastMonth, lastMonthToDate, listSpend },
    daily: daily.slice(-60),
    next7,
    forecast: { alpha: learned.alpha, wape: learned.wape, coverage: learned.coverage },
    byWorkspace: group(cost, (r) => r.workspaceId, wsNames, mStart, now, spend),
    byKey,
    byModel: group(cost, (r) => r.model, new Map(), mStart, now, spend),
    byProduct: group(cost, (r) => r.product, new Map(), mStart, now, spend),
    budgets,
    anomalies,
    hygiene,
    cache,
    spendLimits,
    notes,
  };
}
