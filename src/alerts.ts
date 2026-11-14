import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Analysis } from './analysis.js';
import type { Config } from './config.js';
import { dirs } from './paths.js';
import { Clock, duration } from './time.js';

export interface Alert {
  /** Stable key used for cooldown (e.g. `pace:seven_day:<cycle start>`). */
  key: string;
  level: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
}

const money = (v: number) => (v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`);
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Turn an analysis into alert candidates. Pure; cooldown is applied by `dispatch`. */
export function evaluate(a: Analysis, cfg: Config): Alert[] {
  const clock = new Clock(a.timezone, cfg.weekStart);
  const out: Alert[] = [];
  for (const c of a.cycles) {
    // Limit alerts need a real 100% mark: the plan meter, a learned limit, or your config.
    if (c.status === 'idle' || c.source === 'history') continue;
    const where = `${pct(c.elapsed)} through the cycle (resets ${clock.short(c.end)}, in ${duration(c.end - a.generatedAt)})`;
    if (c.used !== undefined) {
      const crossed = [...cfg.alerts.thresholds].sort((x, y) => y - x).find((t) => c.used! * 100 >= t);
      if (crossed !== undefined)
        out.push({
          key: `threshold:${c.key}:${c.start}:${crossed}`,
          level: crossed >= 90 ? 'critical' : 'warning',
          title: `${c.label}: ${pct(c.used)} used`,
          body: `Crossed ${crossed}%. You are ${where}.`,
        });
    }
    if (c.pace !== undefined && c.elapsed >= 0.1 && c.pace >= cfg.alerts.pace && c.used !== undefined) {
      out.push({
        key: `pace:${c.key}:${c.start}`,
        level: c.pace >= cfg.alerts.pace * 1.4 ? 'critical' : 'warning',
        title: `${c.label}: burning ${c.pace.toFixed(2)}× faster than the cycle`,
        body:
          `Used ${pct(c.used)} while ${where}.` +
          (c.etaFull && c.etaFull < c.end
            ? ` At this rate you hit 100% ${clock.short(c.etaFull)}, ${duration(c.end - c.etaFull)} before reset.`
            : c.projected !== undefined
              ? ` Projected at reset: ${pct(c.projected)}.`
              : '') +
          (c.safeBurnPerHour !== undefined ? ` Sustainable: ≤ ${money(c.safeBurnPerHour)}/h (now ${money(c.burnPerHour)}/h).` : ''),
      });
    } else if (cfg.alerts.projectedExhaustion && c.etaFull && c.etaFull < c.end && c.elapsed >= 0.05) {
      out.push({
        key: `eta:${c.key}:${c.start}`,
        level: 'critical',
        title: `${c.label}: limit projected ${clock.short(c.etaFull)}`,
        body: `That is ${duration(c.end - c.etaFull)} before reset. You are ${where}.`,
      });
    }
  }
  const recentCutoff = a.generatedAt - 3 * 3_600_000;
  for (const an of a.anomalies) {
    if (an.end < recentCutoff && an.kind !== 'day') continue;
    if (an.kind === 'day' && an.start < a.generatedAt - 86_400_000) continue;
    out.push({
      key: `anomaly:${an.id}`,
      level: an.severity === 'extreme' ? 'critical' : 'warning',
      title: `Unusual ${an.kind === 'hour' ? 'hour' : an.kind === 'day' ? 'day' : 'session'}: ${an.label}`,
      body: an.explanation,
    });
  }
  return out;
}

interface State {
  sent: Record<string, number>;
}

function stateFile(): string {
  return path.join(dirs.state(), 'alerts.json');
}

function readState(): State {
  try {
    if (existsSync(stateFile())) return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    /* reset */
  }
  return { sent: {} };
}

function writeState(s: State): void {
  mkdirSync(path.dirname(stateFile()), { recursive: true });
  // Forget keys older than 30 days.
  const cutoff = Date.now() - 30 * 86_400_000;
  for (const [k, t] of Object.entries(s.sent)) if (t < cutoff) delete s.sent[k];
  writeFileSync(stateFile(), JSON.stringify(s));
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function run(cmd: string, args: string[], env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 10_000, env: { ...process.env, ...env } }, (err) => (err ? reject(err) : resolve())),
  );
}

export async function send(alert: Alert, cfg: Config): Promise<string[]> {
  const ch = cfg.alerts.channels;
  const errors: string[] = [];
  const icon = alert.level === 'critical' ? '🔴' : alert.level === 'warning' ? '🟠' : 'ℹ️';
  const text = `${icon} ${alert.title}\n${alert.body}`;
  const tasks: [string, () => Promise<void>][] = [];
  if (ch.console !== false) {
    tasks.push(['console', async () => void process.stdout.write(`[${new Date().toISOString()}] ${text.replace('\n', ' — ')}\n`)]);
  }
  if (ch.desktop) {
    tasks.push([
      'desktop',
      async () => {
        if (process.platform === 'darwin')
          await run('osascript', ['-e', `display notification ${JSON.stringify(alert.body)} with title "ccpulse" subtitle ${JSON.stringify(alert.title)}`]);
        else if (process.platform === 'win32')
          await run('powershell', ['-NoProfile', '-Command', `New-BurntToastNotification -Text 'ccpulse', ${JSON.stringify(alert.title)}`]).catch(() => undefined);
        else await run('notify-send', ['-a', 'ccpulse', '-u', alert.level === 'critical' ? 'critical' : 'normal', alert.title, alert.body]);
      },
    ]);
  }
  if (ch.ntfy?.topic) {
    const server = (ch.ntfy.server || 'https://ntfy.sh').replace(/\/$/, '');
    tasks.push([
      'ntfy',
      async () => {
        const res = await fetch(`${server}/${encodeURIComponent(ch.ntfy!.topic)}`, {
          method: 'POST',
          body: alert.body,
          headers: {
            Title: alert.title.replace(/[^\x20-\x7e]/g, ''),
            Priority: alert.level === 'critical' ? 'urgent' : 'default',
            Tags: 'chart_with_upwards_trend',
            ...(ch.ntfy!.token ? { Authorization: `Bearer ${ch.ntfy!.token}` } : {}),
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
    ]);
  }
  if (ch.telegram?.botToken && ch.telegram.chatId)
    tasks.push(['telegram', () => post(`https://api.telegram.org/bot${ch.telegram!.botToken}/sendMessage`, { chat_id: ch.telegram!.chatId, text })]);
  if (ch.slack?.webhookUrl) tasks.push(['slack', () => post(ch.slack!.webhookUrl, { text })]);
  if (ch.discord?.webhookUrl) tasks.push(['discord', () => post(ch.discord!.webhookUrl, { content: text })]);
  if (ch.webhook?.url) tasks.push(['webhook', () => post(ch.webhook!.url, { source: 'ccpulse', ...alert }, ch.webhook!.headers)]);
  if (ch.command)
    tasks.push([
      'command',
      () => run(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', ch.command!], {
        CCPULSE_LEVEL: alert.level,
        CCPULSE_TITLE: alert.title,
        CCPULSE_BODY: alert.body,
        CCPULSE_KEY: alert.key,
      }),
    ]);
  await Promise.all(
    tasks.map(([name, fn]) =>
      fn().catch((e) => {
        errors.push(`${name}: ${(e as Error).message}`);
      }),
    ),
  );
  return errors;
}

/** Send alerts that are not in cooldown. Returns what was sent. */
export async function dispatch(alerts: Alert[], cfg: Config, opts: { dryRun?: boolean } = {}): Promise<{ sent: Alert[]; errors: string[] }> {
  const state = readState();
  const now = Date.now();
  const cooldown = cfg.alerts.cooldownMinutes * 60_000;
  const sent: Alert[] = [];
  const errors: string[] = [];
  for (const a of alerts) {
    const last = state.sent[a.key];
    if (last && now - last < cooldown) continue;
    // Threshold alerts are one-shot per cycle: a key that was ever sent stays quiet.
    if (last && a.key.startsWith('threshold:')) continue;
    if (!opts.dryRun) {
      errors.push(...(await send(a, cfg)));
      state.sent[a.key] = now;
    }
    sent.push(a);
  }
  if (!opts.dryRun) writeState(state);
  return { sent, errors };
}
