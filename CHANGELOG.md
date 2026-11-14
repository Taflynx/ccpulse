# Changelog

## 0.3.0 — 2026-11-14

- **ccpulse-bar, a Claude Code plugin:** a live usage bar above the prompt in the terminal and the desktop app.
  - One line of solid bars by default, with an even-pace notch, used %, risk and reset.
  - **▸ Details** or `/pulse` expands it to an aligned table.
  - Colors follow the risk, in the theme's palette.
  - Install with `/plugin install ccpulse-bar --marketplace Taflynx/ccpulse`.
- **Cross-platform CLI discovery:**
  - Windows goes through `cmd.exe`, so the npm `.cmd` shims resolve.
  - On macOS and Linux, a login shell finds Homebrew, nvm and volta installs that desktop apps can't see.
  - `CCPULSE_BIN` overrides both, and accepts a JSON array for paths with spaces.
- `ccpulse statusline` is a quiet text summary (plan, used %, pace, risk, reset); `--json` returns the snapshot for integrations.

## 0.2.1 — 2026-11-14

- **New plan lineup (2026-10-30):** Max 5x → **Max**, Max 20x → **Ultra**. Ultra has no 5-hour window (verified accounts) and 10× Pro weekly usage; ccpulse no longer shows a 5-hour window on Ultra.
- **Fable cap:** on Max and Ultra, Fable usage is tracked against half the weekly limit, as its own window with risk and alerts.
- Plan view shows weekly allowance, 5-hour limit, Fable rule and included API credits; plan advice uses the new tier ratios.
- Dated plan catalog (`PLAN_CATALOG` in `src/plan.ts`).
- New logo mark.
- Tests never read the real Claude Code login.

## 0.2.0 — 2026-11-14

Plan awareness, API management and professional analytics.

- **Plan detection:** Pro, Max, Ultra, Team, Enterprise, API key, Bedrock/Vertex/Foundry. Tier, billing cycle, extra usage, auth in use (`ccpulse plan`).
- **Plan value and advice:** API-equivalent value of each billing cycle vs. the price, and tier advice from real weekly peaks.
- **Monte Carlo limit risk:** the probability of hitting each limit before reset, with p10/p50/p90 and burn-down fans. Status and alerts are now driven by probability, and pace alerts stay quiet when the risk is low.
- **Deep analytics (`ccpulse analyze`):** cost anatomy, context economics, working sessions, effort / subagent / entry-point breakdowns, weekly model mix, concentration, regime-change detection, and automatic insights from all of these.
- **Organization API (`ccpulse api`):** spend, forecast, budgets, anomalies and recommendations through the Admin API and the official Anthropic SDK; key enable / disable / archive / rename, workspaces, rate limits and spend limits.
- **Dashboard:** plan bar, risk and burn-down per cycle, deep-analytics and API sections, regime marker, `?focus=` views.
- **Alerts:** limit risk, API budgets, API spend limit, API anomalies, regime change.
- Index v2 records thinking tokens, effort, entry point, subagent and web-search usage. The first run re-indexes once.

## 0.1.0 — 2026-11-14

First release.

- Incremental, ccusage-compatible index of Claude Code logs, with API-equivalent pricing (1-hour cache writes, long-context tiers).
- Cycle pace for the 5-hour and weekly windows. The 100% mark comes from the plan meter, a learned limit, your config or your history.
- Learning loop that calibrates the cost of 100% of each window from plan-meter readings.
- Online-tuned seasonal forecast with empirical ranges and out-of-sample accuracy.
- Quantile-based anomaly detection for hours, days and per-project working sessions, with drivers.
- Insights: peak hours, typical-week heatmap, model mix, what-ifs, cache efficiency.
- Alerts: desktop, ntfy, Telegram, Slack, Discord, webhook and command, with cooldowns.
- Local dashboard, Claude Code status line, `--json` everywhere, and `--demo` mode.
