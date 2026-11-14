# Configuration

ccpulse works with no configuration at all. To change anything, create a config file with `ccpulse config init`. It is written to `~/.config/ccpulse/config.json` (or `$XDG_CONFIG_HOME/ccpulse/config.json`) with mode `600`.

```jsonc
{
  "timezone": "America/New_York",   // default: system time zone
  "weekStart": "monday",            // "monday" | "sunday"
  "metric": "cost",                 // "cost" (API-equivalent, model-weighted) | "tokens"

  "limits": {
    "useOfficial": true,            // read the plan meter behind Claude Code's /usage
    "weeklyReset": "thu 18:00",     // anchor for the weekly cycle when the meter is unavailable
    "sessionCost": 95,              // manual 100% for a 5-hour window (API-equivalent USD)
    "weeklyCost": 1350              // manual 100% for the weekly window
  },

  "plan": {
    "monthlyPrice": 200,            // what you actually pay (default: your tier's list price)
    "billingDay": 18                // override the renewal day (default: subscription start)
  },

  "api": {
    "adminKeyFile": "~/.config/ccpulse/admin.key",   // or CCPULSE_ADMIN_KEY in the environment
    "budgets": [{ "name": "Production", "monthly": 1800, "workspaceId": "wrkspc_…" }],
    "cacheMinutes": 30
  },

  "alerts": {
    "riskProbability": 0.5,         // alert when P(hit limit before reset) reaches this
    "pace": 1.25,                   // alert when used ÷ elapsed reaches this
    "projectedExhaustion": true,    // alert when the limit is projected before reset
    "thresholds": [50, 75, 90],     // alert once per cycle when crossing these percentages
    "anomalyZ": 4,                  // anomaly score threshold (see how-it-works §7)
    "anomalyMin": 2,                // ignore anomalies smaller than this (USD, or M tokens)
    "cooldownMinutes": 180,         // do not repeat the same alert within this window
    "channels": { "desktop": true } // see docs/alerts.md
  }
}
```

Command-line flags override the file: `--tz`, `--week-start`, `--metric` and `--offline`.

## Options

| Key | Default | Description |
|---|---|---|
| `timezone` | system | IANA zone used for every bucket, label and weekly anchor |
| `weekStart` | `monday` | First day of the week for weekly buckets and heatmaps |
| `metric` | `cost` | What trends, forecasts and anomalies measure |
| `limits.useOfficial` | `true` | Use the plan meter when a Claude Code subscription login exists |
| `limits.weeklyReset` | — | `"<weekday> HH:MM"` in your time zone |
| `limits.sessionCost` | — | Manual 100% for session windows |
| `limits.weeklyCost` | — | Manual 100% for weekly windows |
| `plan.monthlyPrice` | list price | Price used for plan-value analytics |
| `plan.billingDay` | subscription start | Day of month your plan renews |
| `api.adminKeyFile` | — | File with an Admin API key (prefer `CCPULSE_ADMIN_KEY`) |
| `api.budgets` | `[]` | Monthly API budgets: `{ name, monthly, workspaceId?, apiKeyId?, model? }` |
| `api.cacheMinutes` | `30` | Admin API response cache |
| `alerts.riskProbability` | `0.5` | Risk alert threshold (Monte Carlo probability) |
| `alerts.pace` | `1.25` | Pace alert threshold (only when risk ≥ 10%) |
| `alerts.projectedExhaustion` | `true` | Alert on projected limit before reset |
| `alerts.thresholds` | `[50,75,90]` | Utilization thresholds |
| `alerts.anomalyZ` | `4` | Anomaly sensitivity (lower = more alerts) |
| `alerts.anomalyMin` | `2` | Minimum anomaly size |
| `alerts.cooldownMinutes` | `180` | Repeat suppression |
| `alerts.channels` | desktop | See [alerts.md](alerts.md) |

## Environment variables

| Variable | Purpose |
|---|---|
| `CLAUDE_CONFIG_DIR` | Claude Code data directories (comma-separated), same as Claude Code and ccusage |
| `CCPULSE_CONFIG` | Use a different config file |
| `CCPULSE_ADMIN_KEY` / `ANTHROPIC_ADMIN_KEY` | Admin API key for organization API analytics and management |
| `CCPULSE_TELEGRAM_BOT_TOKEN`, `CCPULSE_TELEGRAM_CHAT_ID` | Telegram channel |
| `CCPULSE_NTFY_TOPIC`, `CCPULSE_NTFY_SERVER`, `CCPULSE_NTFY_TOKEN` | ntfy channel |
| `CCPULSE_SLACK_WEBHOOK` | Slack incoming webhook |
| `CCPULSE_DISCORD_WEBHOOK` | Discord webhook |
| `CCPULSE_WEBHOOK_URL` | Generic JSON webhook |
| `CCPULSE_OAUTH_TOKEN` | Use this token for the plan meter instead of Claude Code's login |
| `NO_COLOR` / `FORCE_COLOR` | Terminal colors |

## Files on disk

| Path | Contents |
|---|---|
| `~/.config/ccpulse/config.json` | Your configuration |
| `~/.config/ccpulse/pricing.json` | Optional price overrides: `{ "claude-x-1": { "input": 3, "output": 15, "cacheWrite": 3.75, "cacheRead": 0.3 } }` (USD per million tokens) |
| `~/.cache/ccpulse/entries-v1.json.gz` | Incremental log index (safe to delete) |
| `~/.cache/ccpulse/official-usage.json` | Last plan-meter reading, reused for 60 s |
| `~/.local/state/ccpulse/limit-history.jsonl` | Learned-limit snapshots ([how it works §4](how-it-works.md#4-the-learning-loop)) |
| `~/.local/state/ccpulse/alerts.json` | Alert cooldown state |
| `~/.cache/ccpulse/admin-*.json` | Admin API response cache (mode 600) |

The `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` variables are honored.

## JSON output

Every command accepts `--json`. `ccpulse --json` prints the full analysis that the dashboard uses: totals, series, cycles, forecast, anomalies, habits, insights, models and projects. It is handy for scripts, other dashboards or your own agents.

```bash
ccpulse pace --json | jq '.cycles[] | {label, used, pace, etaFull}'
```
