import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { dirs } from './paths.js';
import { adminKey } from './plan.js';

/**
 * Organization-level API data through the official Anthropic SDK (Admin API, beta):
 * usage & cost analytics, API keys, workspaces, rate limits and spend limits.
 * Needs an Admin API key (sk-ant-admin…) in CCPULSE_ADMIN_KEY / ANTHROPIC_ADMIN_KEY.
 */

export interface CostRow {
  /** Bucket start (UTC day), epoch ms. */
  t: number;
  model: string | null;
  workspaceId: string | null;
  apiKeyId: string | null;
  product: string | null;
  /** USD after discounts, before credits. */
  usd: number;
  /** USD at list prices. */
  listUsd: number;
}

export interface UsageRow {
  t: number;
  model: string | null;
  workspaceId: string | null;
  apiKeyId: string | null;
  uncachedInput: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  requests: number;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  status: 'active' | 'archived' | 'expired' | 'inactive';
  createdAt: number;
  expiresAt?: number;
  hint?: string;
  workspaceId?: string;
  owner?: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  createdAt: number;
  archived: boolean;
}

export interface SpendLimitInfo {
  id: string;
  scope: string;
  amount?: number;
  period: string;
  enabled: boolean;
}

export interface RateLimitInfo {
  group: string;
  limits: { type: string; value: number }[];
}

export interface AdminApi {
  readonly demo: boolean;
  organization(): Promise<{ id: string; name: string }>;
  cost(days: number): Promise<CostRow[]>;
  usage(days: number): Promise<UsageRow[]>;
  apiKeys(): Promise<ApiKeyInfo[]>;
  updateApiKey(id: string, change: { status?: 'active' | 'inactive' | 'archived'; name?: string }): Promise<ApiKeyInfo>;
  workspaces(): Promise<WorkspaceInfo[]>;
  rateLimits(): Promise<RateLimitInfo[]>;
  spendLimits(): Promise<SpendLimitInfo[]>;
  setSpendLimit(scope: { type: 'organization' } | { type: 'workspace'; workspace_id: string }, amountUsd: number | null, period: 'daily' | 'weekly' | 'monthly'): Promise<SpendLimitInfo>;
}

export class AdminUnavailable extends Error {}

const DAY = 86_400_000;

function cacheFile(kind: string, key: string): string {
  const h = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return path.join(dirs.cache(), `admin-${kind}-${h}.json`);
}

async function cached<T>(kind: string, key: string, minutes: number, fn: () => Promise<T>): Promise<T> {
  const f = cacheFile(kind, key);
  if (existsSync(f)) {
    try {
      const c = JSON.parse(readFileSync(f, 'utf8'));
      if (Date.now() - c.at < minutes * 60_000) return c.data as T;
    } catch {
      /* refetch */
    }
  }
  const data = await fn();
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ at: Date.now(), data }), { mode: 0o600 });
  return data;
}

const usd = (cents: string | null | undefined) => (cents ? parseFloat(cents) / 100 : 0);

/** The analytics API accepts ≤31 days per request, starting no earlier than 2026-01-01 and within 365 days. */
function windows(days: number, now = Date.now()): { from: string; to: string }[] {
  const end = Math.floor(now / DAY) * DAY + DAY;
  const floor = Math.max(Date.UTC(2026, 0, 1), end - 364 * DAY);
  let start = Math.max(floor, end - days * DAY);
  const out: { from: string; to: string }[] = [];
  while (start < end) {
    const stop = Math.min(end, start + 31 * DAY);
    out.push({ from: new Date(start).toISOString(), to: new Date(stop).toISOString() });
    start = stop;
  }
  return out;
}

export async function getAdmin(cfg: Config, opts: { demo?: boolean } = {}): Promise<AdminApi> {
  if (opts.demo) return (await import('./admin-demo.js')).demoAdmin();
  const key = adminKey(cfg);
  if (!key) throw new AdminUnavailable('No Admin API key. Set CCPULSE_ADMIN_KEY (an sk-ant-admin… key from Claude Console → Settings → Admin keys).');
  let Anthropic: any;
  try {
    Anthropic = (await import('@anthropic-ai/sdk')).default;
  } catch {
    throw new AdminUnavailable('The official Anthropic SDK is needed for API management: npm i -g @anthropic-ai/sdk (or reinstall ccpulse with optional dependencies).');
  }
  const client = new Anthropic({ apiKey: key, defaultHeaders: { 'User-Agent': 'ccpulse' } });
  const org = client.beta.organization;
  const ttl = cfg.api.cacheMinutes;
  const scope = key.slice(-8);

  const collect = async <T>(page: AsyncIterable<T>) => {
    const out: T[] = [];
    for await (const x of page) out.push(x);
    return out;
  };

  return {
    demo: false,
    async organization() {
      return cached('org', scope, 24 * 60, async () => {
        const o = await org.retrieve();
        return { id: o.id, name: o.name };
      });
    },
    async cost(days) {
      return cached('cost', `${scope}:${days}`, ttl, async () => {
        const rows: CostRow[] = [];
        for (const w of windows(days)) {
          const page = org.analytics.cost.list({
            starting_at: w.from,
            ending_at: w.to,
            time_bucket_width: '1d',
            group_by: ['model', 'workspace_id', 'api_key_id', 'product'],
            order_by: 'time',
            order: 'asc',
            limit: 1000,
          });
          for (const r of await collect<any>(page)) {
            rows.push({
              t: Date.parse(r.starting_at),
              model: r.group.model,
              workspaceId: r.group.workspace_id,
              apiKeyId: r.group.api_key_id,
              product: r.group.product,
              usd: usd(r.cost.amount),
              listUsd: usd(r.cost.list_amount),
            });
          }
        }
        return rows;
      });
    },
    async usage(days) {
      return cached('usage', `${scope}:${days}`, ttl, async () => {
        const rows: UsageRow[] = [];
        for (const w of windows(days)) {
          const page = org.analytics.usage.list({
            starting_at: w.from,
            ending_at: w.to,
            time_bucket_width: '1d',
            group_by: ['model', 'workspace_id', 'api_key_id'],
            order_by: 'time',
            order: 'asc',
            limit: 1000,
          });
          for (const r of await collect<any>(page)) {
            const cc = r.usage.cache_creation ?? {};
            rows.push({
              t: Date.parse(r.starting_at),
              model: r.group.model,
              workspaceId: r.group.workspace_id,
              apiKeyId: r.group.api_key_id,
              uncachedInput: r.usage.uncached_input_tokens ?? 0,
              cacheWrite: (cc.ephemeral_5m_input_tokens ?? 0) + (cc.ephemeral_1h_input_tokens ?? 0),
              cacheRead: r.usage.cache_read_input_tokens ?? 0,
              output: r.usage.output_tokens ?? 0,
              requests: r.usage.requests ?? 0,
            });
          }
        }
        return rows;
      });
    },
    async apiKeys() {
      return cached('keys', scope, Math.min(ttl, 10), async () => (await collect<any>(org.apiKeys.list({ limit: 100 }))).map(toKey));
    },
    async updateApiKey(id, change) {
      const k = await org.apiKeys.update(id, change);
      invalidate('keys', scope);
      return toKey(k);
    },
    async workspaces() {
      return cached('workspaces', scope, Math.min(ttl, 60), async () =>
        (await collect<any>(org.workspaces.list({ limit: 100, include_archived: false }))).map((w) => ({
          id: w.id,
          name: w.name,
          createdAt: Date.parse(w.created_at),
          archived: !!w.archived_at,
        })),
      );
    },
    async rateLimits() {
      return cached('ratelimits', scope, 60, async () =>
        (await collect<any>(org.rateLimits.list())).map((r) => ({
          group: `${r.group?.display_name ?? String(r.group?.type ?? 'organization').replace(/_/g, ' ')}${r.models?.length ? ` (${r.models.join(', ')})` : ''}`,
          limits: (r.limits ?? []).map((l: any) => ({ type: l.type, value: l.value })),
        })),
      );
    },
    async spendLimits() {
      return (await collect<any>(org.spendLimits.list())).map(toSpend);
    },
    async setSpendLimit(scopeArg, amountUsd, period) {
      const r = await org.spendLimits.set({ scope: scopeArg, amount: amountUsd === null ? null : (amountUsd * 100).toFixed(6), period });
      return toSpend(r);
    },
  };
}

function invalidate(kind: string, key: string): void {
  try {
    writeFileSync(cacheFile(kind, key), JSON.stringify({ at: 0, data: null }));
  } catch {
    /* ignore */
  }
}

function toKey(k: any): ApiKeyInfo {
  return {
    id: k.id,
    name: k.name,
    status: k.status,
    createdAt: Date.parse(k.created_at),
    expiresAt: k.expires_at ? Date.parse(k.expires_at) : undefined,
    hint: k.partial_key_hint ?? undefined,
    workspaceId: k.scope?.type === 'workspace' ? k.scope.workspace_id : undefined,
    owner: k.principal?.type ?? k.created_by?.type,
  };
}

function toSpend(s: any): SpendLimitInfo {
  const sc = s.scope ?? {};
  return {
    id: s.id,
    scope: sc.type === 'workspace' ? `workspace ${sc.workspace_id}` : sc.type,
    amount: s.amount ? parseFloat(s.amount) / 100 : undefined,
    period: s.period,
    enabled: !!s.is_enabled,
  };
}
