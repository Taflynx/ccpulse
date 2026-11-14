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
export type PlanKind = 'free' | 'pro' | 'max' | 'ultra' | 'team' | 'enterprise' | 'api' | 'cloud' | 'unknown';

/**
 * Consumer plan catalog (claude.com/pricing). Anthropic changes plans from time to time; the
 * catalog is dated, every value can be overridden in config, and the output says which was used.
 * 2026-10-30: Max 5x was renamed Max, Max 20x became Ultra (10× Pro weekly, no 5-hour limit for
 * verified accounts), and Max/Ultra gained monthly API credits and Fable up to half the weekly limit.
 */
export const PLAN_CATALOG = {
  asOf: '2026-11-14',
  source: 'https://claude.com/pricing',
  plans: {
    free: { label: 'Free', price: 0, session: 'limited', weekly: 'limited' },
    pro: { label: 'Pro', price: 20, annualMonthly: 17, session: 1, weekly: 1, fable: 'usage credits' },
    max: { label: 'Max', price: 100, session: 5, weekly: 5, fableWeeklyShare: 0.5, apiCredits: 100, formerly: 'Max 5x' },
    ultra: { label: 'Ultra', price: 200, session: null, weekly: 10, fableWeeklyShare: 0.5, apiCredits: 200, formerly: 'Max 20x' },
  },
} as const;

type CatalogKey = keyof typeof PLAN_CATALOG.plans;

export interface PlanInfo {
  kind: PlanKind;
  /** Human label, e.g. "Ultra", "Max", "Pro", "API (pay as you go)". */
  label: string;
  /** Former name when the plan was renamed (e.g. Ultra ← Max 20x). */
  formerly?: string;
  /** Weekly usage vs. Pro (Max → 5, Ultra → 10). */
  multiplier?: number;
  /** 5-hour window vs. Pro; null = no 5-hour limit (Ultra, verified accounts). */
  sessionMultiplier?: number | null;
  /** True when the plan has no rolling 5-hour limit. */
  noSessionLimit: boolean;
  /** Fable may use up to this share of the weekly limit (Max, Ultra). */
  fableWeeklyShare?: number;
  /** Monthly Claude Platform API credits included with the plan (not usable in Claude Code). */
  apiCredits?: number;
  rateLimitTier?: string;
  billingType?: string;
  /** Pay-as-you-go overage beyond plan limits, billed at API rates. */
  extraUsage?: boolean;
  subscriptionStartedAt?: number;
  seatTier?: string;
  organizationRole?: string;
  /** Monthly price used for value analytics, and where it came from. */
  monthlyPrice?: number;
  priceSource?: 'config' | 'list';
  catalogAsOf: string;
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

/**
 * Map Claude Code's plan fields to the catalog. Rate-limit tiers keep their historical names
 * (`default_claude_max_20x` is Ultra, `default_claude_max_5x` is Max), so names win when present.
 */
export function classifyConsumer(orgType: string, subType: string, tier: string, displayName: string): CatalogKey | 'team' | 'enterprise' | undefined {
  const all = `${orgType} ${subType} ${displayName}`.toLowerCase();
  if (/enterprise/.test(all)) return 'enterprise';
  if (/team/.test(all)) return 'team';
  if (/ultra/.test(all) || /max_20x/.test(tier)) return 'ultra';
  if (/max/.test(all) || /max_5x/.test(tier)) return 'max';
  if (/pro/.test(all) || /pro/.test(tier)) return 'pro';
  if (/free/.test(all)) return 'free';
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

  const tier: string = oauth.rateLimitTier ?? account.organizationRateLimitTier ?? account.userRateLimitTier ?? '';
  const displayName: string = typeof account.planDisplayName === 'string' ? account.planDisplayName : '';
  const consumer = classifyConsumer(account.organizationType ?? '', oauth.subscriptionType ?? '', tier, displayName);

  let kind: PlanKind = 'unknown';
  if (auth.bedrock || auth.vertex || auth.foundry) kind = 'cloud';
  else if (consumer) kind = consumer;
  else if (auth.apiKeyEnv || auth.apiKeyHelper) kind = 'api';

  const cat = kind in PLAN_CATALOG.plans ? (PLAN_CATALOG.plans as Record<string, any>)[kind] : undefined;
  let label: string;
  switch (kind) {
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
    case 'unknown':
      label = 'Unknown';
      break;
    default:
      label = displayName || cat.label;
  }

  if ((kind === 'max' || kind === 'ultra' || kind === 'pro') && auth.apiKeyEnv)
    notes.push('ANTHROPIC_API_KEY is set: Claude Code may bill the API key instead of your subscription. Unset it to use the plan.');
  if (kind === 'api' || kind === 'cloud') notes.push('Pay-as-you-go: local costs are real spend, not API-equivalent estimates.');
  if (kind === 'ultra') notes.push('Ultra has no 5-hour limit for verified accounts; only the weekly window applies.');
  if (cat?.apiCredits) notes.push(`Includes $${cat.apiCredits}/month in Claude Platform API credits (not usable in Claude Code).`);

  let monthlyPrice: number | undefined;
  let priceSource: PlanInfo['priceSource'];
  if (typeof cfg.plan?.monthlyPrice === 'number') [monthlyPrice, priceSource] = [cfg.plan.monthlyPrice, 'config'];
  else if (cat && typeof cat.price === 'number' && cat.price > 0) [monthlyPrice, priceSource] = [cat.price, 'list'];

  const started = account.subscriptionCreatedAt ? Date.parse(account.subscriptionCreatedAt) : NaN;
  const sessionMultiplier = cat ? (cat.session === null ? null : typeof cat.session === 'number' ? cat.session : undefined) : undefined;
  return {
    kind,
    label,
    formerly: cat?.formerly,
    multiplier: cat && typeof cat.weekly === 'number' ? cat.weekly : undefined,
    sessionMultiplier,
    noSessionLimit: sessionMultiplier === null,
    fableWeeklyShare: cat?.fableWeeklyShare,
    apiCredits: cat?.apiCredits,
    rateLimitTier: tier || undefined,
    billingType: account.billingType,
    extraUsage: typeof account.hasExtraUsageEnabled === 'boolean' ? account.hasExtraUsageEnabled : undefined,
    subscriptionStartedAt: Number.isFinite(started) ? started : undefined,
    seatTier: account.seatTier,
    organizationRole: account.organizationRole,
    monthlyPrice,
    priceSource,
    catalogAsOf: PLAN_CATALOG.asOf,
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
