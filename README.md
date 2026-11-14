<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.png">
    <img src="docs/images/logo-light.png" alt="ccpulse" width="380">
  </picture>
</p>

<p align="center">
  <b>Understand, learn from and forecast your Claude Code usage.</b><br>
  Plan & API awareness · Monte Carlo limit risk · forecasts · anomaly detection · deep cost analytics · alerts · a local dashboard.
</p>

<p align="center">
  <a href="https://github.com/Taflynx/ccpulse/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Taflynx/ccpulse/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-2a78d6">
  <img alt="Required dependencies: 0" src="https://img.shields.io/badge/required%20deps-0-1baf7a">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-6250d6"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/dashboard-dark.png">
    <img src="docs/images/dashboard-light.png" alt="ccpulse dashboard: cycle meters with pace and limit ETA, forecasts, daily trend with a 7-day forecast, learned insights and a typical-week heatmap" width="100%">
  </picture>
</p>

---

Usage limits work in cycles: a 5-hour session window and a weekly window. Knowing what you spent yesterday doesn't answer the question that matters mid-week: **am I burning faster than the cycle is moving, and when will I hit the wall?**

ccpulse answers it. It reads the logs Claude Code already writes on your machine, learns your personal rhythm, and tells you:

| | |
|---|---|
| **🪪 What you're on** | Detects your plan (Pro, Max 5x/20x, Team, Enterprise, API, Bedrock/Vertex), tier, billing cycle and extra usage, then shows what your usage was **worth vs. what you pay** and whether a different plan fits |
| **⏱ Where you are in the cycle** | Used % vs. elapsed % for the session and weekly windows, and your **pace** (1.33× = burning a third faster than the clock) |
| **🎲 Whether you'll make it** | The **probability** of hitting each limit before it resets, from 2,000 simulated futures of *your* usage, plus the likely time, the 10–90% range at reset, and a burn-down chart |
| **🏢 Your API spend** | With an Admin key: month-to-date and month-end forecast, budgets with pace, spend by workspace, key and model, anomalies, key hygiene, and key / spend-limit management |
| **🔬 Where the money goes** | Cost anatomy by token type, context economics (200k+ prompts, growth per turn, what `/compact` would save), sessions, effort levels, subagents, model mix over time, regime changes |
| **📈 What's coming** | Forecasts for today, this week, this month and next month, with 80% ranges and **honest, out-of-sample accuracy** |
| **🚨 What's unusual** | Spikes by hour, day and working session, judged against *your* history, with the project and model behind each one |
| **🧠 Your habits** | Peak hours, typical-week heatmap, model mix, cache efficiency, "what if I used Sonnet for routine work" |
| **🔔 Alerts that matter** | Desktop, ntfy, Telegram, Slack, Discord, webhooks or any command, with cooldowns so the same alert doesn't repeat |

## Quick start

```bash
npx ccpulse            # overview in your terminal
npx ccpulse dashboard  # local dashboard at http://127.0.0.1:4477
npx ccpulse plan       # your plan, billing cycle, value vs. price, advice
npx ccpulse analyze    # deep analytics: risk, cost anatomy, context, sessions
npx ccpulse --demo     # try everything on realistic synthetic data
```

Requirements: Node.js 20 or newer, and Claude Code used on this machine. Before the first npm release, run it straight from GitHub with `npx github:Taflynx/ccpulse`. The first run indexes your logs (≈40 s for 5 GB). After that, ccpulse reads only the bytes appended since the last run, so commands finish in about 2 seconds.

## A tour

### Cycle pace: the question you actually have

<img src="docs/images/cli-pace.png" alt="ccpulse pace: session and weekly windows with used vs. elapsed, pace, projected usage at reset, limit ETA and sustainable burn rate" width="100%">

Each bar shows how much of the window you've used. The **│** marks where an even pace would put you right now. When usage is ahead of the marker, ccpulse projects the rest of the cycle from your learned weekly rhythm and tells you when you'd hit the limit and how much hourly burn is sustainable.

### Your plan, and what it's worth

<img src="docs/images/cli-plan.png" alt="ccpulse plan: plan and tier, billing cycle progress, API-equivalent value vs. price for this and previous cycles, and plan advice" width="100%">

ccpulse reads your plan straight from Claude Code's local config (it never reads your e-mail, name or tokens): the plan and tier, the billing type, whether extra usage is on, and when the subscription renews. It then prices this cycle's usage at API rates, so you can see how many times over the plan paid for itself. From real weekly peaks it tells you whether a different tier would fit better.

### Probability, not a straight line

<img src="docs/images/dashboard-deep.png" alt="Deep analytics: cost anatomy by token type, context economics, weekly model mix, working sessions and breakdowns by effort, subagents and entry point" width="100%">

A straight-line projection says "you'll run out Thursday" every Monday morning, and then the weekend happens. ccpulse instead simulates the rest of the cycle 2,000 times:
- **Weekly windows:** each simulated day draws an intensity from your own history and applies it to your learned hourly rhythm.
- **5-hour windows:** a Markov chain models whether you keep working, using real hourly burn.

You get the **chance** of hitting the limit, the likely time, and the 10–90% range at reset. Pace alerts stay quiet when the risk is low.

`ccpulse analyze` also breaks the last 30 days down by:
- token type (are cache writes your biggest cost?);
- context size (how much of your cost is 200k+ prompts?);
- effort level, subagents vs. main thread, and entry point;
- the weekly model mix.

It also flags the day your usage pattern changed.

<details>
<summary><b>See <code>ccpulse analyze</code> in the terminal</b></summary>

<img src="docs/images/cli-analyze.png" alt="ccpulse analyze output" width="100%">
</details>

### Your API spend, managed

<img src="docs/images/dashboard-api.png" alt="API spend: month to date, month-end forecast, budgets with pace, daily spend with forecast, recommendations, spend by workspace and key" width="100%">

With an Admin API key, ccpulse adds your organization's API spend next to your subscription:
- month to date and a month-end forecast with a range;
- budgets per workspace, key or model, with pace alerts;
- the workspace and key behind every spike;
- recommendations: projected spend-limit overruns, unused or expiring keys, and low cache hit rates.

You can also disable, enable, archive and rename keys, and set spend limits, all from the terminal. See **[docs/api.md](docs/api.md)**.

### Forecasts with receipts

<img src="docs/images/cli-forecast.png" alt="ccpulse forecast: today, week, month and next month with 80% ranges, a 7-day outlook and backtest accuracy" width="100%">

Every forecast comes with its own track record. The model re-tunes itself each day using only the data before that day, and the reported error and range coverage come from that strictly out-of-sample backtest.

### Anomalies, explained

<img src="docs/images/cli-anomalies.png" alt="ccpulse anomalies: unusual hours, days and working sessions with typical values, ratio and drivers" width="100%">

Agent usage is spiky and full of zeros, so averages and standard deviations cry wolf. ccpulse compares each hour with the same hour of day, each day with your recent days, and each working session with that project's past sessions. Every anomaly names its drivers: project, model and session.

### What your usage says

<img src="docs/images/cli-insights.png" alt="ccpulse insights: peak hours, heaviest day, week-over-week change, model mix, what-if on a cheaper model, cache hit rate and a typical-week heatmap" width="100%">

### Everything at a glance

<img src="docs/images/cli-overview.png" alt="ccpulse overview: cycles, usage and forecast table, last 48 hours vs. normal, insights and anomalies" width="100%">

<details>
<summary><b>More: reports, hourly dashboard view, status line</b></summary>

<br>

`ccpulse report daily --by model` (also `hourly`, `weekly` and `monthly`):

<img src="docs/images/cli-report.png" alt="ccpulse report daily with per-model breakdown" width="100%">

Hourly view: the last 48 hours against your learned normal for each hour of the week.

<img src="docs/images/dashboard-hourly.png" alt="Dashboard hourly view with the learned normal overlaid" width="100%">

The Claude Code status line: used %, pace and cycle progress in one line.

<img src="docs/images/cli-statusline.png" alt="ccpulse status line" width="70%">

</details>

## Commands

| Command | |
|---|---|
| `ccpulse` | Overview: cycles, forecast, last 48 h vs. normal, top insights and anomalies |
| `ccpulse pace` | Cycle detail: pace, risk, burn and sustainable burn, learned limits |
| `ccpulse plan` | Plan, tier, billing cycle, value vs. price, plan advice |
| `ccpulse analyze` | Monte Carlo limit risk, cost anatomy, context economics, sessions, effort / subagent / entry-point breakdowns, model mix, regime change |
| `ccpulse api [keys\|workspaces\|limits\|spend-limits]` | Organization API spend and management ([docs/api.md](docs/api.md)) |
| `ccpulse report <hourly\|daily\|weekly\|monthly> [-n N] [--by model\|project]` | Usage tables with Δ vs. the previous period |
| `ccpulse forecast` | Today / week / month / next month, the next 7 days, trend, accuracy |
| `ccpulse anomalies [--days N]` | Unusual hours, days and working sessions |
| `ccpulse insights` | Habits, heatmap, what-ifs |
| `ccpulse dashboard [--open] [--port N]` | Local web dashboard (binds to 127.0.0.1) |
| `ccpulse watch [--interval 5m] [--once] [--dry-run]` | Evaluate the alert rules and notify |
| `ccpulse statusline` | One-line summary for Claude Code's status bar |
| `ccpulse alerts test` | Send a test alert to every configured channel |
| `ccpulse config init` | Create `~/.config/ccpulse/config.json` |

Global flags: `--json`, `--metric cost|tokens`, `--tz <zone>`, `--week-start monday|sunday`, `--offline`, `--fresh`, `--demo` and `--no-color`. API commands add `--yes` and `--period`.

## Alerts in two minutes

```bash
ccpulse config init                  # writes ~/.config/ccpulse/config.json
export CCPULSE_NTFY_TOPIC=my-secret-topic   # or Telegram, Slack, Discord, webhook…
ccpulse alerts test
ccpulse watch                        # or run `ccpulse watch --once` from cron / systemd / launchd
```

You get alerted when:
- the chance of **hitting a limit before reset** reaches 50%;
- you cross **50 / 75 / 90%** of a window;
- an hour, day or session is **unusual for you**;
- an **API budget** paces over or is projected over;
- API spend is heading past your **organization spend limit**.

Pace alerts stay quiet when the simulated risk is low.

All thresholds are configurable. See [docs/alerts.md](docs/alerts.md).

## Status line

Add this to `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "npx -y ccpulse statusline" } }
```

The line reads `5h 36% 1.1×@33% │ wk 61% 1.3×@46% │ today $133→$327`: used %, pace, and @ how far through the cycle you are. Results are cached for 60 seconds, so refreshes take about 50 ms.

## How it works

ccpulse is built from these layers. Each one is documented in depth in [docs/how-it-works.md](docs/how-it-works.md).

1. **Index.** It reads `~/.claude/projects/**/*.jsonl` incrementally and deduplicates responses with the same rules as [ccusage](https://github.com/ccusage/ccusage); its daily totals match ccusage's.
2. **Price.** Every response is priced at API-equivalent cost, including 1-hour cache writes and long-context tiers. Cost weights tokens by model, which tracks plan limits better than raw token counts.
3. **Find the 100% mark.** ccpulse looks for it in this order:
   - the plan meter behind Claude Code's `/usage`, read-only;
   - a limit **learned** from past meter readings, so it keeps working offline;
   - your config;
   - your own history, which is clearly labeled and never triggers limit alerts.
4. **Learn your rhythm.** A recency-weighted profile of your 168 hours of the week, plus a seasonal forecast whose smoothing is re-tuned online every day.
5. **Judge with quantiles.** Anomalies are scored as `(x − p50) / (p90 − p50)` against the same hour of day, your recent days, or the same project's sessions.
6. **Simulate.** Monte Carlo over day-level intensity draws (weekly windows), or a Markov chain of active and idle hours (5-hour windows), turns pace into a probability.
7. **Know the plan.** Plan metadata comes from Claude Code's local config; organization API data comes from the Admin API through the official Anthropic SDK.

## Privacy

- Nothing leaves your machine except two kinds of call. The first is the plan-meter request, which goes to Anthropic with your own token; turn it off with `--offline`. The second is the alert channels you configure.
- No telemetry, no accounts, no required runtime dependencies. The official Anthropic SDK is an optional dependency, loaded only for API commands.
- Plan detection reads only plan metadata from Claude Code's config: never tokens, e-mail addresses or names.
- The dashboard listens on loopback, blocks DNS-rebinding, and sends a strict CSP.

## FAQ

<details><summary><b>Is the cost what I pay?</b></summary>

Only if you're billed through the API. On Pro and Max plans it's an *API-equivalent* number: a consistent, model-weighted way to measure usage, the same basis ccusage uses. The percentages come from the plan meter when it's available.
</details>

<details><summary><b>Why does the plan meter show more than my logs?</b></summary>

The meter counts everything on your account, including claude.ai and other machines. Local logs only cover Claude Code here. When the gap is large, ccpulse points it out.
</details>

<details><summary><b>How accurate are the forecasts?</b></summary>

It depends on how regular you are, and ccpulse tells you. `ccpulse forecast` prints the average daily error and how often reality fell inside the 80% range over the last 42 days, measured out-of-sample. Weekly totals are far more predictable than single days.
</details>

<details><summary><b>How is the plan value computed?</b></summary>

Your Claude Code usage in the current billing cycle (which renews on your subscription's start date) is priced at API list rates and compared with the plan's price: the list price for your tier, or `plan.monthlyPrice` if you set it. It measures how much the subscription is saving you, not what you pay.
</details>

<details><summary><b>Does it work with ccusage?</b></summary>

Yes. Use ccusage for multi-agent reports and ccpulse for the analytics and alerts. The two read the same files and don't interfere.
</details>

<details><summary><b>The plan-meter endpoint isn't public. Is that safe?</b></summary>

ccpulse calls it read-only with the login Claude Code already has. It never refreshes, copies or stores the token. If the endpoint changes, ccpulse falls back to learned or configured limits. You can turn it off entirely with `limits.useOfficial: false`.
</details>

## Documentation

- [How it works](docs/how-it-works.md): data, dedup, pricing, cycles, the learning loop, forecasting and anomaly math
- [Configuration](docs/configuration.md): every option, environment variables, files on disk
- [Alerts](docs/alerts.md): rules, channels, running in the background
- [API spend & management](docs/api.md): Admin API setup, budgets, keys, spend limits
- [Contributing](CONTRIBUTING.md)

## Credits

- Log parsing and deduplication follow [ccusage](https://github.com/ccusage/ccusage) by ryoppippi (MIT).
- Pricing data is from [models.dev](https://models.dev), via ccusage's snapshot.

## License

[MIT](LICENSE)
