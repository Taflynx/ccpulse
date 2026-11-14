#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatch, evaluate, send } from './alerts.js';
import { analyze } from './analysis.js';
import { renderAnomalies, renderForecast, renderInsights, renderOverview, renderPace, renderReport, renderStatusline } from './commands.js';
import { configPath, loadConfig, writeDefaultConfig, type Config } from './config.js';
import { loadEntries } from './loader.js';
import { c } from './render/term.js';
import type { Granularity } from './types.js';

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-') && VALUE_FLAGS.has(k)) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else if (a.startsWith('-') && a.length > 1) {
      const k = SHORT[a.slice(1)] ?? a.slice(1);
      if (VALUE_FLAGS.has(k) && argv[i + 1]) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const VALUE_FLAGS = new Set(['tz', 'metric', 'last', 'by', 'interval', 'port', 'host', 'days', 'week-start']);
const SHORT: Record<string, string> = { j: 'json', h: 'help', v: 'version', n: 'last', p: 'port' };

function version(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    return JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

const HELP = `${c.bold('ccpulse')} — understand, learn from and forecast your Claude Code usage

${c.bold('USAGE')}
  ccpulse [command] [options]

${c.bold('COMMANDS')}
  (none)              Overview: cycle pace, forecast, last 48h vs. normal, insights, anomalies
  pace                Where you are in the 5-hour and weekly cycles, and how fast you burn
  report <g>          Tables by hour | day | week | month   (aliases: hourly, daily, weekly, monthly)
  forecast            Today / week / month / next month, with ranges and backtested accuracy
  anomalies           Unusual hours, days and sessions vs. your own history
  insights            Learned habits: peak hours, model mix, cache efficiency, what-ifs
  dashboard           Local web dashboard (127.0.0.1 only by default)
  watch               Check periodically and alert on pace, thresholds and anomalies
  statusline          One-line summary for the Claude Code status line
  alerts test         Send a test alert to every configured channel
  config [init|path]  Create or locate ~/.config/ccpulse/config.json

${c.bold('OPTIONS')}
  -j, --json          Machine-readable output
  --metric <m>        cost (API-equivalent, default) | tokens
  --tz <zone>         IANA time zone (default: system)
  --week-start <d>    monday (default) | sunday
  -n, --last <n>      Number of periods for report (default 24h / 30d / 12w / 12m)
  --by <dim>          Add a breakdown: model | project
  --days <n>          Anomaly lookback in days (default 7)
  --offline           Do not query the plan meter; use learned or configured limits
  --fresh             Rebuild the log index from scratch
  --demo              Use realistic synthetic data (try ccpulse without any logs)
  --interval <dur>    watch: 30s, 5m, 1h (default 5m)
  --once              watch: run one check and exit (for cron / launchd / systemd timers)
  --dry-run           watch: print alerts without sending or recording them
  -p, --port <n>      dashboard port (default 4477)
  --host <addr>       dashboard bind address (default 127.0.0.1)
  --open              dashboard: open the browser
  --no-color          Disable colors (also honors NO_COLOR)

${c.dim('Data stays on your machine. Costs are API-equivalent estimates, the same basis ccusage uses.')}
`;

function applyFlags(cfg: Config, a: Args): Config {
  const f = a.flags;
  if (typeof f.tz === 'string') cfg.timezone = f.tz;
  if (f.metric === 'tokens' || f.metric === 'cost') cfg.metric = f.metric;
  if (f['week-start'] === 'sunday' || f['week-start'] === 'monday') cfg.weekStart = f['week-start'];
  return cfg;
}

function parseInterval(s: string | boolean | undefined): number {
  if (typeof s !== 'string') return 5 * 60_000;
  const m = s.match(/^(\d+(?:\.\d+)?)(s|m|h)?$/);
  if (!m) return 5 * 60_000;
  const n = parseFloat(m[1]);
  return Math.max(15_000, n * (m[2] === 'h' ? 3_600_000 : m[2] === 's' ? 1000 : 60_000));
}

const GRAN: Record<string, Granularity> = {
  hour: 'hour', hourly: 'hour', h: 'hour',
  day: 'day', daily: 'day', d: 'day',
  week: 'week', weekly: 'week', w: 'week',
  month: 'month', monthly: 'month', m: 'month',
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const f = args.flags;
  if (f.version) return void console.log(version());
  if (f.help) return void process.stdout.write(HELP);
  const cfg = applyFlags(loadConfig(), args);
  const cmd = args._[0] ?? 'overview';
  const json = !!f.json;
  const offline = !!f.offline;
  const demo = !!f.demo;
  const progress = !json && process.stderr.isTTY;
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  switch (cmd) {
    case 'overview': {
      const a = await analyze(cfg, { offline, demo, fresh: !!f.fresh, progress });
      return void console.log(json ? JSON.stringify(a, null, 2) : renderOverview(a, cfg));
    }
    case 'pace':
    case 'cycle': {
      const a = await analyze(cfg, { offline, demo, fresh: !!f.fresh, progress });
      return void (json ? print({ cycles: a.cycles, official: a.official, calibration: a.calibration }) : console.log(renderPace(a, cfg)));
    }
    case 'report':
    case 'hourly':
    case 'daily':
    case 'weekly':
    case 'monthly': {
      const g = GRAN[cmd === 'report' ? (args._[1] ?? 'day') : cmd];
      if (!g) throw new Error(`unknown granularity "${args._[1]}" (hour | day | week | month)`);
      const n = typeof f.last === 'string' ? Math.max(1, parseInt(f.last, 10)) : { hour: 24, day: 30, week: 12, month: 12 }[g];
      const entries = demo ? (await import('./demo.js')).demoData(Date.now(), cfg.timezone).entries : (await loadEntries({ fresh: !!f.fresh, progress })).entries;
      const by = f.by === 'model' || f.by === 'project' ? f.by : undefined;
      if (json) {
        const { bucketize } = await import('./aggregate.js');
        const { Clock } = await import('./time.js');
        const clock = new Clock(cfg.timezone, cfg.weekStart);
        let from = clock.bucketStart(Date.now(), g);
        for (let i = 1; i < n; i++) from = clock.bucketStart(from - 1, g);
        return print({ granularity: g, timezone: clock.tz, buckets: bucketize(entries, clock, g, from, Date.now() + 1) });
      }
      return void console.log(renderReport(entries, cfg, g, n, by));
    }
    case 'forecast': {
      const a = await analyze(cfg, { offline, demo, fresh: !!f.fresh, progress });
      return void (json ? print(a.forecast) : console.log(renderForecast(a)));
    }
    case 'anomalies': {
      const days = typeof f.days === 'string' ? parseInt(f.days, 10) : 7;
      const a = await analyze(cfg, { offline, demo, fresh: !!f.fresh, progress, anomalyDays: days });
      return void (json ? print(a.anomalies) : console.log(renderAnomalies(a)));
    }
    case 'insights': {
      const a = await analyze(cfg, { offline, demo, fresh: !!f.fresh, progress });
      return void (json ? print({ insights: a.insights, habits: a.habits }) : console.log(renderInsights(a, cfg)));
    }
    case 'statusline': {
      // Claude Code pipes session JSON on stdin; we do not need it, but must not block on it.
      if (!process.stdin.isTTY) process.stdin.resume().on('data', () => undefined);
      // Claude Code refreshes the status line often: serve a result up to 60s old.
      const { dirs } = await import('./paths.js');
      const { readFileSync, writeFileSync, mkdirSync, statSync } = await import('node:fs');
      const file = path.join(dirs.cache(), `statusline-${cfg.metric}.txt`);
      try {
        if (!f.fresh && !demo && Date.now() - statSync(file).mtimeMs < 60_000) {
          process.stdout.write(readFileSync(file, 'utf8'));
          return process.exit(0);
        }
      } catch {
        /* no cache yet */
      }
      const a = await analyze(cfg, { offline, demo, anomalyDays: 1 });
      const out = renderStatusline(a) + '\n';
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, out);
      process.stdout.write(out);
      return process.exit(0);
    }
    case 'watch': {
      const every = parseInterval(f.interval);
      const tick = async () => {
        try {
          const a = await analyze(cfg, { offline, demo, anomalyDays: 1 });
          const candidates = evaluate(a, cfg);
          const { sent, errors } = await dispatch(candidates, cfg, { dryRun: !!f['dry-run'] });
          if (f['dry-run'] || json) for (const s of sent) console.log(json ? JSON.stringify(s) : `${s.level.toUpperCase()}  ${s.title}\n  ${s.body}`);
          for (const e of errors) process.stderr.write(`ccpulse: alert channel failed: ${e}\n`);
          if (!sent.length && (f.once || f['dry-run']) && !json) console.log(c.dim('No new alerts.'));
        } catch (e) {
          process.stderr.write(`ccpulse: check failed: ${(e as Error).message}\n`);
        }
      };
      await tick();
      if (f.once || f['dry-run']) return;
      process.stderr.write(c.dim(`ccpulse watch: checking every ${Math.round(every / 1000)}s. Ctrl+C to stop.\n`));
      setInterval(tick, every);
      return;
    }
    case 'dashboard':
    case 'ui': {
      const { startDashboard } = await import('./dashboard/server.js');
      await startDashboard(cfg, {
        port: typeof f.port === 'string' ? parseInt(f.port, 10) : 4477,
        host: typeof f.host === 'string' ? f.host : '127.0.0.1',
        open: !!f.open,
        offline,
        demo,
      });
      return;
    }
    case 'alerts': {
      if (args._[1] !== 'test') throw new Error('usage: ccpulse alerts test');
      const errors = await send(
        { key: 'test', level: 'warning', title: 'ccpulse test alert', body: 'If you can read this, the channel works.' },
        { ...cfg, alerts: { ...cfg.alerts, channels: { ...cfg.alerts.channels, console: true } } },
      );
      for (const e of errors) console.error(c.red(`✗ ${e}`));
      if (!errors.length) console.log(c.green('✓ sent to all configured channels'));
      return;
    }
    case 'config': {
      const sub = args._[1] ?? 'path';
      if (sub === 'init') return void console.log(`Config: ${writeDefaultConfig()}`);
      if (sub === 'show') return print(cfg);
      return void console.log(configPath());
    }
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n`);
      process.stdout.write(HELP);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  process.stderr.write(`ccpulse: ${(e as Error).message}\n`);
  process.exit(1);
});
