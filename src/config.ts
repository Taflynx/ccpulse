import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dirs } from './paths.js';
import type { Metric } from './types.js';

export interface Config {
  /** IANA time zone; defaults to the system zone. */
  timezone?: string;
  weekStart: 'monday' | 'sunday';
  /** What "usage" means for trends: API-equivalent cost (default, model-weighted) or raw tokens. */
  metric: Metric;
  limits: {
    /**
     * Read real utilization from the same endpoint Claude Code's `/usage` uses
     * (subscription plans only). Uses your existing Claude Code login; nothing is stored.
     */
    useOfficial: boolean;
    /** Manual fallbacks, in API-equivalent USD per window. */
    sessionCost?: number;
    weeklyCost?: number;
    /** Weekly reset anchor when the official endpoint is unavailable, e.g. "thu 18:00". */
    weeklyReset?: string;
  };
  plan: {
    /** What you actually pay per month (overrides list prices) for plan-value analytics. */
    monthlyPrice?: number;
    /** Day of month your subscription renews (defaults to the subscription start day). */
    billingDay?: number;
  };
  api: {
    /** File holding an Admin API key (sk-ant-admin…). Prefer CCPULSE_ADMIN_KEY in the environment. */
    adminKeyFile?: string;
    /** Local monthly budgets for API spend, evaluated by `watch` with pace alerts. */
    budgets: { name: string; monthly: number; workspaceId?: string; apiKeyId?: string; model?: string }[];
    /** Minutes to cache Admin API responses (data refreshes every few hours upstream). */
    cacheMinutes: number;
  };
  alerts: {
    /** Probability (0–1) of hitting a limit before reset that triggers a risk alert. */
    riskProbability: number;
    /** Alert when used% / elapsed% exceeds this. */
    pace: number;
    /** Alert when the projection says you will hit the limit before it resets. */
    projectedExhaustion: boolean;
    /** Alert when utilization crosses these percentages. */
    thresholds: number[];
    /** Robust z-score for anomaly alerts. */
    anomalyZ: number;
    /** Ignore anomalies smaller than this (USD or tokens, per metric). */
    anomalyMin: number;
    /** Do not repeat the same alert within this many minutes. */
    cooldownMinutes: number;
    channels: {
      console?: boolean;
      desktop?: boolean;
      ntfy?: { topic: string; server?: string; token?: string };
      telegram?: { botToken: string; chatId: string };
      slack?: { webhookUrl: string };
      discord?: { webhookUrl: string };
      webhook?: { url: string; headers?: Record<string, string> };
      command?: string;
    };
  };
}

export const defaults: Config = {
  weekStart: 'monday',
  metric: 'cost',
  limits: { useOfficial: true },
  plan: {},
  api: { budgets: [], cacheMinutes: 30 },
  alerts: {
    riskProbability: 0.5,
    pace: 1.25,
    projectedExhaustion: true,
    thresholds: [50, 75, 90],
    anomalyZ: 4,
    anomalyMin: 2,
    cooldownMinutes: 180,
    channels: { console: true, desktop: true },
  },
};

export function configPath(): string {
  return process.env.CCPULSE_CONFIG || path.join(dirs.config(), 'config.json');
}

function merge<T>(base: T, over: any): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? merge(out[k], v) : v;
  }
  return out;
}

export function loadConfig(): Config {
  let cfg = defaults;
  const p = configPath();
  if (existsSync(p)) {
    try {
      cfg = merge(defaults, JSON.parse(readFileSync(p, 'utf8')));
    } catch (e) {
      process.stderr.write(`ccpulse: could not parse ${p}: ${(e as Error).message}\n`);
    }
  }
  // Secrets can come from the environment so the config file can be shared.
  const env = process.env;
  const ch = (cfg = merge(cfg, {})).alerts.channels;
  if (env.CCPULSE_NTFY_TOPIC) ch.ntfy = { topic: env.CCPULSE_NTFY_TOPIC, server: env.CCPULSE_NTFY_SERVER, token: env.CCPULSE_NTFY_TOKEN };
  if (env.CCPULSE_TELEGRAM_BOT_TOKEN && env.CCPULSE_TELEGRAM_CHAT_ID)
    ch.telegram = { botToken: env.CCPULSE_TELEGRAM_BOT_TOKEN, chatId: env.CCPULSE_TELEGRAM_CHAT_ID };
  if (env.CCPULSE_SLACK_WEBHOOK) ch.slack = { webhookUrl: env.CCPULSE_SLACK_WEBHOOK };
  if (env.CCPULSE_DISCORD_WEBHOOK) ch.discord = { webhookUrl: env.CCPULSE_DISCORD_WEBHOOK };
  if (env.CCPULSE_WEBHOOK_URL) ch.webhook = { url: env.CCPULSE_WEBHOOK_URL };
  return cfg;
}

export function writeDefaultConfig(): string {
  const p = configPath();
  if (existsSync(p)) return p;
  mkdirSync(path.dirname(p), { recursive: true });
  const sample = {
    ...defaults,
    limits: { useOfficial: true, weeklyReset: undefined, sessionCost: undefined, weeklyCost: undefined },
  };
  writeFileSync(p, JSON.stringify(sample, null, 2) + '\n', { mode: 0o600 });
  return p;
}
