import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';
import { claudeCredentialsFile } from './paths.js';
import type { Clock } from './time.js';

/**
 * What the user is on, detected from Claude Code's own local config. Only plan metadata is read:
 * no tokens, e-mail addresses or names ever leave these functions.
 */
export type PlanKind = 'pro' | 'max' | 'team' | 'enterprise' | 'api' | 'cloud' | 'unknown';

export interface PlanInfo {
  kind: PlanKind;
  /** Human label, e.g. "Max 20x", "Pro", "API (Console)". */
  label: string;
  /** Usage multiplier vs. Pro where known (Max 5x → 5, Max 20x → 20). */
  multiplier?: number;
  rateLimitTier?: string;
  billingType?: string;
  /** Pay-as-you-go overage beyond plan limits. */
  extraUsage?: boolean;
  subscriptionStartedAt?: number;
  seatTier?: string;
  organizationRole?: string;
  /** Monthly price used for value analytics, and where it came from. */
  monthlyPrice?: number;
  priceSource?: 'config' | 'list';
  /** How Claude Code authenticates right now. */
  auth: {
    oauth: boolean;
    apiKeyEnv: boolean;
    apiKeyHelper: boolean;
    bedrock: boolean;
    vertex: boolean;
    foundry: boolean;
    customBaseUrl: boolean;
  };
  /** True when ccpulse has an Admin API credential for org-level API analytics. */
  adminConfigured: boolean;
  notes: string[];
}

/** List prices (USD/month) used only when the user has not configured `plan.monthlyPrice`. */
export const LIST_PRICES: Record<string, number> = {
  pro: 20,
  max_5x: 100,
  max_20x: 200,
};

function readJson(file: string): any {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

function claudeJsonPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.split(',')[0]?.trim();
  if (dir && existsSync(path.join(dir, '.claude.json'))) return path.join(dir, '.claude.json');
  return path.join(homedir(), '.claude.json');
}

function tierInfo(tier?: string): { multiplier?: number; key?: string } {
  if (!tier) return {};
  const m = tier.match(/max_(\d+)x/);
  if (m) return { multiplier: +m[1], key: `max_${m[1]}x` };
  if (/pro/.test(tier)) return { multiplier: 1, key: 'pro' };
  return {};
}

export function adminKey(cfg?: Config): string | undefined {
  const env = process.env.CCPULSE_ADMIN_KEY || process.env.ANTHROPIC_ADMIN_KEY;
  if (env) return env.trim();
  const file = cfg?.api?.adminKeyFile;
  if (file) {
    try {
      return readFileSync(file.replace(/^~(?=$|\/)/, homedir()), 'utf8').trim();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function detectPlan(cfg: Config): PlanInfo {
  const notes: string[] = [];
  const account = readJson(claudeJsonPath())?.oauthAccount ?? {};
  const credFile = claudeCredentialsFile();
  const oauth = (credFile ? readJson(credFile)?.claudeAiOauth : undefined) ?? {};
  const settings = readJson(path.join(homedir(), '.claude', 'settings.json')) ?? {};
  const env = { ...(settings.env ?? {}), ...process.env } as Record<string, string | undefined>;

  const auth = {
    oauth: !!oauth.subscriptionType || !!account.organizationType,
    apiKeyEnv: !!env.ANTHROPIC_API_KEY || !!env.ANTHROPIC_AUTH_TOKEN,
    apiKeyHelper: typeof settings.apiKeyHelper === 'string',
    bedrock: env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_BEDROCK === 'true',
    vertex: env.CLAUDE_CODE_USE_VERTEX === '1' || env.CLAUDE_CODE_USE_VERTEX === 'true',
    foundry: env.CLAUDE_CODE_USE_FOUNDRY === '1' || env.CLAUDE_CODE_USE_FOUNDRY === 'true',
    customBaseUrl: !!env.ANTHROPIC_BASE_URL,
  };

  const orgType: string = account.organizationType ?? '';
  const subType: string = oauth.subscriptionType ?? '';
  const tier: string = oauth.rateLimitTier ?? account.organizationRateLimitTier ?? account.userRateLimitTier ?? '';
  const ti = tierInfo(tier);

  let kind: PlanKind = 'unknown';
  if (auth.bedrock || auth.vertex || auth.foundry) kind = 'cloud';
  else if (/enterprise/.test(orgType) || subType === 'enterprise') kind = 'enterprise';
  else if (/team/.test(orgType) || subType === 'team') kind = 'team';
  else if (/max/.test(orgType) || subType === 'max') kind = 'max';
  else if (/pro/.test(orgType) || subType === 'pro') kind = 'pro';
  else if (auth.apiKeyEnv || auth.apiKeyHelper) kind = 'api';

  let label: string;
  switch (kind) {
    case 'max':
      label = ti.multiplier ? `Max ${ti.multiplier}x` : 'Max';
      break;
    case 'pro':
      label = 'Pro';
      break;
    case 'team':
      label = `Team${account.seatTier ? ` (${String(account.seatTier).replace(/_/g, ' ')})` : ''}`;
      break;
    case 'enterprise':
      label = 'Enterprise';
      break;
    case 'api':
      label = 'API (pay as you go)';
      break;
    case 'cloud':
      label = auth.bedrock ? 'Amazon Bedrock' : auth.vertex ? 'Google Vertex AI' : 'Microsoft Foundry';
      break;
    default:
      label = 'Unknown';
  }
  if (typeof account.planDisplayName === 'string' && account.planDisplayName && kind !== 'api' && kind !== 'cloud')
    label = account.planDisplayName;

  if ((kind === 'max' || kind === 'pro') && auth.apiKeyEnv)
    notes.push('ANTHROPIC_API_KEY is set: Claude Code may bill the API key instead of your subscription. Unset it to use the plan.');
  if (kind === 'api' || kind === 'cloud') notes.push('Pay-as-you-go: local costs are real spend, not API-equivalent estimates.');

  let monthlyPrice: number | undefined;
  let priceSource: PlanInfo['priceSource'];
  if (typeof cfg.plan?.monthlyPrice === 'number') [monthlyPrice, priceSource] = [cfg.plan.monthlyPrice, 'config'];
  else {
    const key = kind === 'pro' ? 'pro' : kind === 'max' ? ti.key : undefined;
    if (key && LIST_PRICES[key] !== undefined) [monthlyPrice, priceSource] = [LIST_PRICES[key], 'list'];
  }

  const started = account.subscriptionCreatedAt ? Date.parse(account.subscriptionCreatedAt) : NaN;
  return {
    kind,
    label,
    multiplier: kind === 'max' || kind === 'pro' ? ti.multiplier : undefined,
    rateLimitTier: tier || undefined,
    billingType: account.billingType,
    extraUsage: typeof account.hasExtraUsageEnabled === 'boolean' ? account.hasExtraUsageEnabled : undefined,
    subscriptionStartedAt: Number.isFinite(started) ? started : undefined,
    seatTier: account.seatTier,
    organizationRole: account.organizationRole,
    monthlyPrice,
    priceSource,
    auth,
    adminConfigured: !!adminKey(cfg),
    notes,
  };
}

/**
 * Current monthly billing period. Stripe renews on the subscription's start timestamp (UTC) each
 * month, clamped to the month's last day; `plan.billingDay` overrides the day (00:00 UTC).
 */
export function billingPeriod(plan: PlanInfo, cfg: Config, _clock: Clock, now: number): { start: number; end: number; elapsed: number; day: number; days: number } | undefined {
  const anchor = plan.subscriptionStartedAt ? new Date(plan.subscriptionStartedAt) : undefined;
  const day = cfg.plan?.billingDay ?? anchor?.getUTCDate();
  if (!day) return undefined;
  const timeOfDay = cfg.plan?.billingDay || !anchor ? 0 : plan.subscriptionStartedAt! % 86_400_000;
  const at = (y: number, m: number) => Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())) + timeOfDay;
  const n = new Date(now);
  let y = n.getUTCFullYear();
  let m = n.getUTCMonth();
  if (at(y, m) > now) {
    m -= 1;
    if (m < 0) [m, y] = [11, y - 1];
  }
  const start = at(y, m);
  const end = m === 11 ? at(y + 1, 0) : at(y, m + 1);
  const days = Math.round((end - start) / 86_400_000);
  return { start, end, elapsed: (now - start) / (end - start), day: Math.floor((now - start) / 86_400_000) + 1, days };
}
