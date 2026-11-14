import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCredentialsFile, dirs } from './paths.js';

/**
 * Real plan utilization, as shown by Claude Code's `/usage`.
 *
 * This endpoint is not a documented public API. ccpulse uses it read-only with your existing
 * Claude Code login, never refreshes or stores the token, and degrades gracefully when the
 * response shape changes or the call fails.
 */
export interface OfficialWindow {
  /** e.g. `five_hour`, `seven_day`, `seven_day_opus`. */
  key: string;
  /** 0–100 */
  utilization: number;
  resetsAt?: number;
}

export interface OfficialUsage {
  fetchedAt: number;
  windows: OfficialWindow[];
}

export type OfficialResult =
  | { ok: true; usage: OfficialUsage; cached: boolean }
  | { ok: false; reason: string };

const ENDPOINT = process.env.CCPULSE_USAGE_ENDPOINT || 'https://api.anthropic.com/api/oauth/usage';
const TTL_MS = 60_000;

function readToken(): { token?: string; reason?: string } {
  if (process.env.CCPULSE_OAUTH_TOKEN) return { token: process.env.CCPULSE_OAUTH_TOKEN };
  let raw: string | undefined;
  const file = claudeCredentialsFile();
  if (file) {
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      /* fall through */
    }
  }
  if (!raw && process.platform === 'darwin') {
    try {
      raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
    } catch {
      /* not logged in */
    }
  }
  if (!raw) return { reason: 'no Claude Code login found (subscription plans only)' };
  try {
    const j = JSON.parse(raw);
    const o = j.claudeAiOauth ?? j;
    if (!o.accessToken) return { reason: 'Claude Code login has no OAuth token (API-key users have no plan limits)' };
    if (typeof o.expiresAt === 'number' && o.expiresAt < Date.now())
      return { reason: 'Claude Code login token expired; open Claude Code once to refresh it' };
    return { token: o.accessToken };
  } catch {
    return { reason: 'could not read Claude Code credentials' };
  }
}

/** Parse any `{ utilization, resets_at }` objects, so new windows show up without a release. */
export function parseOfficial(body: unknown, now = Date.now()): OfficialUsage {
  const windows: OfficialWindow[] = [];
  if (body && typeof body === 'object') {
    for (const [key, v] of Object.entries(body as Record<string, any>)) {
      if (!v || typeof v !== 'object' || typeof v.utilization !== 'number') continue;
      const r = v.resets_at ? Date.parse(v.resets_at) : NaN;
      windows.push({ key, utilization: v.utilization, resetsAt: Number.isFinite(r) ? r : undefined });
    }
  }
  return { fetchedAt: now, windows };
}

function cacheFile(): string {
  return path.join(dirs.cache(), 'official-usage.json');
}

export async function fetchOfficial(opts: { maxAgeMs?: number } = {}): Promise<OfficialResult> {
  const maxAge = opts.maxAgeMs ?? TTL_MS;
  const cf = cacheFile();
  if (existsSync(cf)) {
    try {
      const c = JSON.parse(readFileSync(cf, 'utf8')) as OfficialUsage;
      if (Date.now() - c.fetchedAt < maxAge) return { ok: true, usage: c, cached: true };
    } catch {
      /* refetch */
    }
  }
  const { token, reason } = readToken();
  if (!token) return { ok: false, reason: reason ?? 'no token' };
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': 'ccpulse',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, reason: `usage endpoint returned HTTP ${res.status}` };
    const usage = parseOfficial(await res.json());
    if (!usage.windows.length) return { ok: false, reason: 'usage endpoint returned no windows (format changed?)' };
    mkdirSync(path.dirname(cf), { recursive: true });
    writeFileSync(cf, JSON.stringify(usage), { mode: 0o600 });
    return { ok: true, usage, cached: false };
  } catch (e) {
    return { ok: false, reason: `usage endpoint unreachable: ${(e as Error).message}` };
  }
}

export const WINDOW_LENGTH: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
  seven_day_opus: 7 * 86_400_000,
  seven_day_sonnet: 7 * 86_400_000,
  seven_day_oauth_apps: 7 * 86_400_000,
};

export function windowLength(key: string): number | undefined {
  if (WINDOW_LENGTH[key]) return WINDOW_LENGTH[key];
  if (key.startsWith('seven_day')) return 7 * 86_400_000;
  const h = key.match(/^(\w+)_hour/);
  if (h) return ({ one: 1, five: 5, six: 6, twelve: 12 } as Record<string, number>)[h[1]] ?? undefined;
  return undefined;
}

export function windowLabel(key: string): string {
  const map: Record<string, string> = {
    five_hour: 'Session (5h)',
    seven_day: 'Weekly (all models)',
    seven_day_opus: 'Weekly (Opus)',
    seven_day_sonnet: 'Weekly (Sonnet)',
    seven_day_oauth_apps: 'Weekly (apps)',
  };
  return map[key] ?? key.replace(/_/g, ' ');
}
