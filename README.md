# ccpulse

**Understand, learn from and forecast your Claude Code usage.**

ccpulse reads Claude Code's local logs and turns them into answers:

- **Where am I in the cycle?** Your 5-hour session and weekly windows, how much you've used, how far the cycle has advanced, and your **pace** (used ÷ elapsed).
- **Will I run out?** Projected usage at reset, and *when* you would hit 100% if you keep going like this.
- **Is this normal?** Hourly, daily and session anomalies, judged against **your own** history (same hour of day, same project).
- **What's coming?** Today, this week, this month and next month, with an 80% range and a **backtested, out-of-sample accuracy** shown next to every forecast.
- **What are my habits?** Peak hours, a typical-week heatmap, model mix, cache efficiency, biggest risers, and "what if" estimates.
- **Tell me when it matters.** Alerts to desktop, ntfy, Telegram, Slack, Discord, a webhook or any shell command.

```
Cycles
Session (5h)         ██████████▓░░░░░░░░░░░░░░░░░░░   36% used  ·   33% of cycle  ● on pace
  ↳ pace 1.09×  ·  resets Sat 15:00 (in 3h 21m)  ·  projected at reset 92%  ·  source: plan meter
Weekly (all models)  ███████████████████░░░░│░░░░░░   61% used  ·   46% of cycle  ● fast
  ↳ pace 1.33×  ·  resets Thu 18:00 (in 3d 19h)  ·  projected at reset 128%  ·  limit ≈ Wed 04:00 (1d 14h early)

Usage & forecast  (API-equivalent USD)
            so far  forecast     80% range  last time     Δ
Today         $133      $327     $176–$512     $98.40  +232%
This week    $1.2k     $2.1k   $1.7k–$2.9k      $1.6k   +31%
```

It complements [ccusage](https://github.com/ccusage/ccusage). ccusage is the reference for *what happened*: it reports daily, weekly, monthly and session usage across 20+ agents. ccpulse follows the same parsing and deduplication rules for Claude Code (its daily totals match ccusage), and adds the analytics on top: hourly resolution, cycle pace, learned limits, forecasting, anomaly detection and alerts.

## Install

Requires Node.js 20+.

```bash
npx ccpulse            # run once
npm i -g ccpulse       # or install the `ccpulse` command
```

The first run indexes your logs (about 40 s for 5 GB). After that ccpulse reads only the new bytes, so later runs take about 2 s.

## Commands

| Command | What it shows |
|---|---|
| `ccpulse` | Overview: cycles, forecast, the last 48 h vs. your normal, top insights and anomalies |
| `ccpulse pace` | Detailed cycle status: pace, projection, limit ETA, burn rate, sustainable burn rate, learned limits |
| `ccpulse report hourly\|daily\|weekly\|monthly [-n N] [--by model\|project]` | Tables with Δ vs. the previous period |
| `ccpulse forecast` | Today / week / month / next month, the next 7 days, weekly trend, backtest accuracy |
| `ccpulse anomalies [--days N]` | Unusual hours, days and working sessions, with their drivers |
| `ccpulse insights` | Learned habits, a typical-week heatmap, what-ifs |
| `ccpulse dashboard [--open]` | Local web dashboard at http://127.0.0.1:4477 |
| `ccpulse watch [--interval 5m] [--once] [--dry-run]` | Checks and sends alerts |
| `ccpulse statusline` | A compact line for the Claude Code status bar |
| `ccpulse alerts test` | Sends a test alert to every configured channel |
| `ccpulse config init` | Writes `~/.config/ccpulse/config.json` |

Every command accepts `--json`, `--metric cost|tokens`, `--tz <IANA zone>`, `--offline` and `--fresh`.

## How it works

### Data

- **Source:** `~/.claude/projects/**/*.jsonl` and `~/.config/claude/projects`. `CLAUDE_CONFIG_DIR` is honored, including comma-separated lists.
- **Deduplication** follows ccusage: one row per message ID + request ID, so the content blocks of one response count once. Sidechain replays (`/btw`, subagent logs that copy parent messages) are dropped.
- **Cost** is an API-equivalent estimate based on the [models.dev](https://models.dev) pricing snapshot that ccusage ships, filtered to Claude models. 1-hour cache writes are priced at 2× input, and long-context tiers are applied. To override or add models, use `~/.config/ccpulse/pricing.json`.
- **Metric:** by default, trends use API-equivalent cost. Cost weights tokens by model, which is closer to how plan limits behave than raw token counts. `--metric tokens` switches to raw tokens.

### Cycles and pace

ccpulse looks for the real 100% mark in this order:

1. **Plan meter.** This is the read-only endpoint Claude Code's `/usage` screen uses (Pro/Max). It needs your existing Claude Code login; ccpulse never refreshes or stores the token. It gives the real utilization and reset times. *The endpoint is not documented; if it changes, ccpulse falls back to the next options.*
2. **Learned limit.** Each time the plan meter is read, ccpulse records how much local usage produced that percentage. From those readings it learns roughly how many API-equivalent dollars equal 100% of each window. This keeps pace and projections working offline. The data lives in `~/.local/state/ccpulse/limit-history.jsonl`.
3. **Your config:** `limits.sessionCost`, `limits.weeklyCost` and `limits.weeklyReset` (e.g. `"thu 18:00"`).
4. **Your history.** Without a real limit, the 100% mark is your 95th-percentile session or your heaviest week. ccpulse labels this clearly and **never raises limit alerts** from it.

For each window ccpulse computes:

- **Pace** = used% ÷ elapsed%. 1.0 means even pace; 1.33× means you're burning a third faster than the cycle advances.
- **Projection:**
  - 5-hour window: the live burn rate.
  - Weekly window: your learned hour-of-week profile for the remaining hours, scaled by how intense the last 24 h were compared with your normal.
- **Limit ETA:** when the projection crosses 100%, if that happens before the reset.
- **Sustainable burn:** the hourly rate that lands exactly at 100% at reset.

The plan meter counts all usage, including claude.ai and other machines. The local logs only cover Claude Code on this machine. When the two disagree a lot, ccpulse tells you.

### Learning and forecasting

- **Profile.** A recency-weighted average of every hour-of-week slot (168 slots) over the last 8 weeks. It powers "your normal" on the hourly chart, the weekly projections and the intraday forecast.
- **Daily model.** Seasonal exponential smoothing: a level times a weekday index. The smoothing factor is **learned online**: each day uses the value that best predicted the 42 days before it. The model adapts when your usage regime changes, and every backtest prediction is strictly out-of-sample.
- **Ranges** come from the empirical distribution of your own forecast errors, not from a textbook assumption. Next to them ccpulse prints its average daily error and how often reality landed inside the range. Heavy agent usage is bursty, and ccpulse says so instead of pretending to be precise.

### Anomalies

Usage is zero-heavy and bursty, so standard deviations over-alert. ccpulse uses quantiles instead:

- **Hours** are compared with the same hour of day over the previous 28 days.
- **Days** are compared with the previous 56 days.
- **Working sessions** (a session split at idle gaps of 2 hours or more) are compared with the same project's sessions.

The score is `(value − p50) / max(p90 − p50, floor)`. Every anomaly lists its drivers: project, model and session.

## Alerts

`ccpulse watch` evaluates these rules:

| Alert | When |
|---|---|
| Pace | used ÷ elapsed ≥ `alerts.pace` (default 1.25) and at least 10% of the cycle has passed |
| Projected exhaustion | the limit is projected to be reached before reset |
| Threshold | utilization crosses each of `alerts.thresholds` (default 50/75/90), once per cycle |
| Anomaly | an unusual hour, day or session (robust score ≥ `alerts.anomalyZ`) |

Repeats are suppressed for `alerts.cooldownMinutes`.

```jsonc
// ~/.config/ccpulse/config.json  (ccpulse config init)
{
  "metric": "cost",
  "weekStart": "monday",
  "limits": { "useOfficial": true, "weeklyReset": "thu 18:00" },
  "alerts": {
    "pace": 1.25,
    "thresholds": [50, 75, 90],
    "anomalyZ": 4,
    "anomalyMin": 2,
    "cooldownMinutes": 180,
    "channels": {
      "desktop": true,
      "ntfy": { "topic": "my-private-topic" },
      "telegram": { "botToken": "…", "chatId": "…" },
      "slack": { "webhookUrl": "…" },
      "discord": { "webhookUrl": "…" },
      "webhook": { "url": "https://example.com/hook" },
      "command": "say \"$CCPULSE_TITLE\""
    }
  }
}
```

Secrets can also come from the environment: `CCPULSE_TELEGRAM_BOT_TOKEN`, `CCPULSE_TELEGRAM_CHAT_ID`, `CCPULSE_NTFY_TOPIC`, `CCPULSE_SLACK_WEBHOOK`, `CCPULSE_DISCORD_WEBHOOK` and `CCPULSE_WEBHOOK_URL`.

To run `watch` in the background, pick one of the ready-made files in [`examples/`](examples): a systemd user timer, a launchd agent, or a cron line. Alternatively, keep `ccpulse watch` running in a terminal.

## Claude Code status line

Add this to `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "ccpulse statusline" } }
```

The line looks like `5h 36% 1.1×@33% │ wk 61% 1.3×@46% │ today $133→$327`: used%, pace, and @ how far the cycle has advanced. Results are cached for 60 s, so the status line costs about 50 ms.

## Privacy and security

- Everything runs locally. There is no telemetry. The only network calls are:
  - the plan meter, sent to Anthropic with your own token; you can disable it with `--offline` or `limits.useOfficial: false`;
  - the alert channels you configure.
- The dashboard binds to `127.0.0.1` and rejects requests with a foreign `Host` header (DNS-rebinding protection). It sends a strict CSP and loads nothing from a CDN.
- The config file is created with mode `600`.

## Limitations

- Costs are API-equivalent estimates. Subscription plans don't bill per token; ccpulse uses cost as a model-weighted measure of usage.
- The plan-meter endpoint is undocumented and may change without notice.
- Logs only exist for Claude Code on this machine. claude.ai and other machines appear only through the plan meter.

## Development

```bash
npm install
npm test            # builds and runs the unit tests
npm run dev -- pace # run from source
```

## Credits

- The parsing and deduplication rules come from [ccusage](https://github.com/ccusage/ccusage) by @ryoppippi (MIT).
- Pricing data is from [models.dev](https://models.dev), via ccusage's snapshot.

## License

MIT
