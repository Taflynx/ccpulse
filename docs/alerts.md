# Alerts

`ccpulse watch` analyzes your usage, evaluates the rules below, and sends what's new to your channels.

```bash
ccpulse watch                 # check every 5 minutes until stopped
ccpulse watch --interval 15m  # custom interval (30s, 5m, 1h)
ccpulse watch --once          # one check, for cron / systemd / launchd
ccpulse watch --dry-run       # show what would be sent; send and record nothing
ccpulse alerts test           # send a test alert to every channel
```

## Rules

| Alert | Fires when | Level |
|---|---|---|
| **Limit risk** | Monte Carlo P(hit before reset) ≥ `alerts.riskProbability` (50%) | warning; critical at 80% |
| **Pace** | used ÷ elapsed ≥ `alerts.pace` (1.25) after 10% of the cycle, *and* simulated risk ≥ 10% | warning; critical at 1.4 × `alerts.pace` (1.75 by default) |
| **Projected exhaustion** | the projection reaches 100% before reset (only when no simulation is available) | critical |
| **Threshold** | utilization crosses each of `alerts.thresholds` (50/75/90). Fires once per cycle | warning; critical at 90%+ |
| **Anomaly** | an unusual hour or session in the last 3 h, or an unusual day today | warning; critical if extreme |
| **API budget** | a budget is pacing ahead (`warn`) or projected over (`critical`) | once per budget, state and month |
| **API spend limit** | month-end forecast ≥ 95% of the organization's monthly spend limit | critical, once per month |
| **API anomaly** | an unusual day of org spend, or a key bursting above its own norm | warning |
| **Regime change** | your daily usage level shifted significantly in the last 10 days | info |

Limit alerts (pace, projection, thresholds) need a real 100% mark: the plan meter, a learned limit or your config. They never fire against history-based baselines.

Each alert has a stable key, for example `pace:seven_day:<cycle start>`. The same key is suppressed for `alerts.cooldownMinutes` (180 by default). Threshold alerts fire once per cycle.

Example message:

```
🟠 Weekly (all models): burning 1.33× faster than the cycle
Used 32% while 24% through the cycle (resets Thu 18:00, in 5d 7h). At this rate you hit 100% Thu 13:08,
4h 52m before reset. Sustainable: ≤ $1.67/h (now $2.37/h).
```

## Channels

Configure channels in `~/.config/ccpulse/config.json` under `alerts.channels`, or with environment variables. You can enable any number at once.

### Desktop

```json
"desktop": true
```

| Platform | How it's sent |
|---|---|
| Linux | `notify-send` (libnotify) |
| macOS | `osascript` |
| Windows | the BurntToast PowerShell module, if installed |

### ntfy (phone push, no account needed)

```json
"ntfy": { "topic": "pick-a-long-random-topic", "server": "https://ntfy.sh", "token": "optional" }
```

Install the ntfy app and subscribe to the same topic. Anyone who knows a topic name can read it, so make it long and random, or use your own server or a token.

### Telegram

```json
"telegram": { "botToken": "123456:ABC…", "chatId": "123456789" }
```

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. Message your bot once.
3. Get your chat ID from `https://api.telegram.org/bot<token>/getUpdates`.

### Slack / Discord

```json
"slack":   { "webhookUrl": "https://hooks.slack.com/services/…" },
"discord": { "webhookUrl": "https://discord.com/api/webhooks/…" }
```

### Webhook

```json
"webhook": { "url": "https://example.com/hooks/ccpulse", "headers": { "Authorization": "Bearer …" } }
```

The webhook receives a POST with this body:

```json
{ "source": "ccpulse", "key": "pace:seven_day:1794400000000", "level": "warning", "title": "…", "body": "…" }
```

### Command

```json
"command": "say \"$CCPULSE_TITLE\""
```

The command runs with `CCPULSE_LEVEL`, `CCPULSE_TITLE`, `CCPULSE_BODY` and `CCPULSE_KEY` in its environment. Use it for anything else: Pushover, Home Assistant, a smart light, your own agent.

### Console

Alerts are always printed to stdout as well, so logs from cron or systemd keep a record. Set `"console": false` to turn this off.

## Running in the background

Ready-made files are in [`examples/`](../examples).

**Linux (systemd user timer)**

```bash
cp examples/ccpulse-watch.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ccpulse-watch.timer
journalctl --user -u ccpulse-watch   # history
```

**macOS (launchd)**

```bash
cp examples/com.ccpulse.watch.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ccpulse.watch.plist
```

**cron**

```cron
*/5 * * * * PATH=/usr/local/bin:/usr/bin:/bin ccpulse watch --once >> ~/.cache/ccpulse/watch.log 2>&1
```

Background jobs don't inherit your shell profile. Put channel secrets in the config file, or set them in the unit or plist environment.
