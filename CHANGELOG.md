# Changelog

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
