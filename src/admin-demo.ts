import type { AdminApi, ApiKeyInfo, CostRow, SpendLimitInfo, UsageRow, WorkspaceInfo } from './admin.js';
import { mulberry32 } from './analytics/advanced.js';

/** A synthetic Console organization for `--demo`: three workspaces, five keys, two months of spend. */
export function demoAdmin(): AdminApi {
  const DAY = 86_400_000;
  const today = Math.floor(Date.now() / DAY) * DAY;
  const workspaces: WorkspaceInfo[] = [
    { id: 'wrkspc_demo_prod', name: 'production', createdAt: today - 300 * DAY, archived: false },
    { id: 'wrkspc_demo_stage', name: 'staging', createdAt: today - 200 * DAY, archived: false },
    { id: 'wrkspc_demo_lab', name: 'research', createdAt: today - 90 * DAY, archived: false },
  ];
  const keys: ApiKeyInfo[] = [
    { id: 'apikey_demo_web', name: 'web-app (prod)', status: 'active', createdAt: today - 280 * DAY, hint: 'sk-ant-…Xq3', workspaceId: 'wrkspc_demo_prod', owner: 'service_account' },
    { id: 'apikey_demo_jobs', name: 'batch-jobs (prod)', status: 'active', createdAt: today - 150 * DAY, hint: 'sk-ant-…9Lk', workspaceId: 'wrkspc_demo_prod', owner: 'service_account' },
    { id: 'apikey_demo_stage', name: 'staging', status: 'active', createdAt: today - 190 * DAY, hint: 'sk-ant-…a1F', workspaceId: 'wrkspc_demo_stage', owner: 'user' },
    { id: 'apikey_demo_lab', name: 'research notebooks', status: 'active', createdAt: today - 80 * DAY, expiresAt: today + 10 * DAY, hint: 'sk-ant-…Zp0', workspaceId: 'wrkspc_demo_lab', owner: 'user' },
    { id: 'apikey_demo_old', name: 'old-prototype', status: 'active', createdAt: today - 400 * DAY, hint: 'sk-ant-…k7Q', workspaceId: 'wrkspc_demo_stage', owner: 'user' },
  ];
  const spend: SpendLimitInfo[] = [{ id: 'sl_demo_org', scope: 'organization', amount: 3000, period: 'monthly', enabled: true }];
  const plan: [string, string, string, number, string][] = [
    // key, workspace, model, base $/day, product
    ['apikey_demo_web', 'wrkspc_demo_prod', 'claude-sonnet-5-5', 34, 'messages_api'],
    ['apikey_demo_web', 'wrkspc_demo_prod', 'claude-haiku-5-5', 6, 'messages_api'],
    ['apikey_demo_jobs', 'wrkspc_demo_prod', 'claude-opus-5-5', 18, 'batch_api'],
    ['apikey_demo_stage', 'wrkspc_demo_stage', 'claude-sonnet-5-5', 7, 'messages_api'],
    ['apikey_demo_lab', 'wrkspc_demo_lab', 'claude-opus-5-5', 11, 'messages_api'],
  ];
  const r = mulberry32(42);
  const cost: CostRow[] = [];
  const usage: UsageRow[] = [];
  for (let d = today - 75 * DAY; d <= today; d += DAY) {
    const dow = new Date(d).getUTCDay();
    const weekend = dow === 0 || dow === 6 ? 0.45 : 1;
    const growth = 1 + (75 - (today - d) / DAY) * 0.006;
    for (const [key, ws, model, base, product] of plan) {
      let v = base * weekend * growth * Math.exp((r() - 0.5) * 0.5);
      if (key === 'apikey_demo_lab' && d >= today - 3 * DAY) v *= 3.4; // a runaway notebook
      if (d === today) v *= 0.45; // partial day
      cost.push({ t: d, model, workspaceId: ws, apiKeyId: key, product, usd: v, listUsd: product === 'batch_api' ? v * 2 : v });
      const perTok = model.includes('opus') ? 9e-6 : model.includes('haiku') ? 0.4e-6 : 4e-6;
      const tokens = v / perTok;
      usage.push({ t: d, model, workspaceId: ws, apiKeyId: key, uncachedInput: tokens * 0.18, cacheWrite: tokens * 0.07, cacheRead: tokens * 0.7, output: tokens * 0.05, requests: Math.round(tokens / 9000) });
    }
  }
  return {
    demo: true,
    async organization() {
      return { id: 'org_demo', name: 'Acme Labs (demo)' };
    },
    async cost(days) {
      return cost.filter((c) => c.t > today - days * DAY);
    },
    async usage(days) {
      return usage.filter((c) => c.t > today - days * DAY);
    },
    async apiKeys() {
      return keys;
    },
    async updateApiKey(id, change) {
      const k = keys.find((x) => x.id === id);
      if (!k) throw new Error(`no such key ${id}`);
      if (change.status) k.status = change.status;
      if (change.name) k.name = change.name;
      return k;
    },
    async workspaces() {
      return workspaces;
    },
    async rateLimits() {
      return [
        { group: 'Claude Opus (claude-opus-5-5)', limits: [{ type: 'requests_per_minute', value: 4000 }, { type: 'input_tokens_per_minute', value: 2_000_000 }, { type: 'output_tokens_per_minute', value: 400_000 }] },
        { group: 'Claude Sonnet (claude-sonnet-5-5)', limits: [{ type: 'requests_per_minute', value: 4000 }, { type: 'input_tokens_per_minute', value: 4_000_000 }, { type: 'output_tokens_per_minute', value: 800_000 }] },
      ];
    },
    async spendLimits() {
      return spend;
    },
    async setSpendLimit(scope, amount, period) {
      const s: SpendLimitInfo = { id: `sl_demo_${spend.length}`, scope: scope.type === 'workspace' ? `workspace ${scope.workspace_id}` : 'organization', amount: amount ?? undefined, period, enabled: amount !== null };
      spend.push(s);
      return s;
    },
  };
}
