# How ccpulse works

This page explains every number ccpulse shows: where it comes from, how it's computed, and how far to trust it.

- [1. Data](#1-data)
- [2. Pricing and the usage metric](#2-pricing-and-the-usage-metric)
- [3. Cycles and pace](#3-cycles-and-pace)
- [4. The learning loop](#4-the-learning-loop)
- [5. Your profile](#5-your-profile)
- [6. Forecasting](#6-forecasting)
- [7. Anomaly detection](#7-anomaly-detection)
- [8. Insights](#8-insights)
- [9. Plan detection and value](#9-plan-detection-and-value)
- [10. Limit risk: Monte Carlo](#10-limit-risk-monte-carlo)
- [11. Deep analytics](#11-deep-analytics)
- [12. Organization API analytics](#12-organization-api-analytics)
- [13. Performance](#13-performance)

## 1. Data

Claude Code appends one JSON line per event to `~/.claude/projects/<project>/<session>.jsonl`; newer versions use `~/.config/claude/projects`. Assistant responses carry a `usage` block:

```jsonc
{
  "type": "assistant",
  "timestamp": "2026-11-14T14:54:06.883Z",
  "sessionId": "…", "requestId": "req_…", "cwd": "/home/me/web-app",
  "message": {
    "id": "msg_…", "model": "claude-opus-5-5",
    "usage": {
      "input_tokens": 4, "output_tokens": 655,
      "cache_read_input_tokens": 98270, "cache_creation_input_tokens": 1520,
      "cache_creation": { "ephemeral_1h_input_tokens": 1520, "ephemeral_5m_input_tokens": 0 }
    }
  }
}
```

**Discovery.** ccpulse reads `CLAUDE_CONFIG_DIR` (one path or a comma-separated list), otherwise both default locations, and walks `projects/` recursively.

**Incremental index.** Log files are append-only. For each file, ccpulse caches its size, its mtime, the byte offset after the last complete line, and the compact rows parsed so far. On the next run it reads only the new tail:

- a file that grew is read from the cached offset;
- a file that shrank or was rewritten is re-parsed from the start;
- an unterminated last line is used if it parses, but the offset is not advanced past it, so it's read again once complete.

The cache lives at `~/.cache/ccpulse/entries-v1.json.gz`. `--fresh` rebuilds it.

**Deduplication** follows ccusage, so daily totals agree with it:

- Claude Code writes one line per content block of a response. Lines sharing **message ID + request ID** count once.
- Sidechain logs (`/btw`, subagent replays) can repeat a parent message under the same message ID with a different request ID. The non-sidechain copy wins.
- Without a request ID, real `msg_` IDs still collapse. Gateway placeholder IDs also key on session and timestamp.

**Project** is the last path segment of the `cwd` recorded with each response, falling back to the encoded project directory name.

## 2. Pricing and the usage metric

Every response is priced at API list price per million tokens. The table is bundled from the [models.dev](https://models.dev) snapshot that ccusage ships:

```
cost = input·p_in + output·p_out + cache_write_5m·p_cw + cache_write_1h·2·p_in + cache_read·p_cr
```

- When the prompt (input plus all cache tokens) exceeds a model's threshold, its long-context tier applies.
- Fast-mode responses use the `-fast` price when one exists.
- Model IDs are normalized: `claude-opus-5-5-20261001` → `claude-opus-5.5`, `us.anthropic.claude-sonnet-5-5-v1:0` → `claude-sonnet-5.5`, and so on.
- Unknown models count as $0 and are listed in a warning.
- `~/.config/ccpulse/pricing.json` overrides or adds entries.

**Why cost and not tokens?** Plan limits are not "N tokens". An Opus response consumes more of your allowance than a Haiku response of the same size, and cache reads are much cheaper than fresh input. API-equivalent cost is a consistent, model-weighted measure that moves with your limits far more closely than raw token counts. `--metric tokens` switches every trend to tokens if you prefer.

## 3. Cycles and pace

A **cycle** is a usage window with a reset: the 5-hour session window, the weekly window, and any per-model weekly window the plan meter reports (for example `seven_day_opus`).

### Where 100% comes from

| Source | Label | When |
|---|---|---|
| Plan meter | `plan meter` | Claude Code's `/usage` endpoint answered. This gives real utilization and reset times |
| Learned limit | `learned limit` | No live reading, but earlier readings taught ccpulse what 100% costs ([§4](#4-the-learning-loop)) |
| Config | `your config` | `limits.sessionCost` / `limits.weeklyCost` |
| History | `vs. your history` | None of the above: 100% is your 95th-percentile session or your heaviest week of the last 12 |

With the history source, percentages are relative to *you*, not to a limit. ccpulse labels them that way, caps their status at "watch", and never sends limit alerts from them.

Without the plan meter, the weekly window needs a reset anchor. ccpulse uses the last reset time it learned; failing that, `limits.weeklyReset` (e.g. `"thu 18:00"`); failing that, a rolling 7 days. Session windows follow ccusage's block rule: a block starts at the floored hour of the first message after the previous block ended, and lasts 5 hours.

### The numbers

For a window `[start, end)` at time `now`:

```
elapsed   = (now − start) / (end − start)
used      = utilization from the meter, or usedCost / limitCost
pace      = used / elapsed                      (1.00 = even pace)
limitCost = usedCost / used                     (live: what 100% costs right now)
```

**Projection to reset:**

- **5-hour window:** `usedCost + burnRate(last 60 min) × remaining`.
- **Weekly window:** `usedCost + Σ profile(hour) × intensity` over the remaining hours, where
  - `profile(hour)` is your learned expected usage for that hour of the week ([§5](#5-your-profile));
  - `intensity = actual(last 24h) / expected(last 24h)`, clamped to [0.3, 3].

  This captures "I'm having a heavy week" without assuming you'll work at 3 a.m. at today's peak rate.
- **Per-model windows** scale the profile by that model family's share of the last 7 days.

The **limit ETA** walks the projection forward in 15-minute steps until it crosses 100%. The **sustainable burn** is `(1 − used) × limitCost / remaining hours`.

**Status:**

| Status | Condition |
|---|---|
| `critical` | ≥ 90% used, or limit projected before reset |
| `warn` (burning fast) | pace ≥ `alerts.pace`, or ≥ 75% used |
| `watch` | pace ≥ 1.05 |
| `ok` | otherwise |

> The plan meter covers your whole account (claude.ai, other machines). Local logs cover Claude Code on this machine. If the learned limit is much larger than the live ratio implies, ccpulse notes that other usage is likely counting toward the meter.

## 4. The learning loop

Each time ccpulse reads the plan meter (at most once per window every 10 minutes), it appends a snapshot to `~/.local/state/ccpulse/limit-history.jsonl`:

```json
{"at":…, "key":"seven_day", "utilization":42, "resetsAt":…, "localCost":512.4, "localTokens":…}
```

`localCost` is the API-equivalent cost of your local logs inside that window at that moment. Each snapshot is one estimate of what 100% costs:

```
limitCost ≈ localCost / (utilization / 100)
```

ccpulse keeps the most recent 40 informative readings (utilization ≥ 8%; low readings are rounded to whole percent and noisy). The **median** is the learned limit, and the **interquartile spread** is its uncertainty (`±` in `ccpulse pace`). The last seen `resetsAt` anchors the weekly cycle offline.

The result: after a few days of normal use, pace, projections and alerts keep working offline, behind a proxy, or if the endpoint changes.

## 5. Your profile

The profile is your "normal". It is the expected usage in each of the 168 hours of the week:

```
profile[weekday, hour] = Σ w·x / Σ w   over the last 8 weeks,  w = 0.8^(weeks ago)
```

Recent weeks count more, so the profile follows changes in your routine within a couple of weeks. Slots never observed (less than a week of data) fall back to the average for that hour of day. All calendar math is time-zone aware, including DST transitions and zones with :30/:45 offsets.

The profile drives:
- the "your normal" line on the hourly chart;
- the weekly projection;
- the intraday share used to finish today's forecast.

## 6. Forecasting

### Daily model

Seasonal exponential smoothing on daily totals:

```
index[w] = mean(days with weekday w) / mean(all days)        last 56 days; shrunk toward 1 if < 4 samples
level    = EWMA_α( value / index[weekday] )                  last 28 days
forecast(day) = level × index[weekday(day)]
```

### Online tuning

There is no single right α. A steady user wants slow smoothing, and someone whose usage swings week to week wants fast smoothing. ccpulse evaluates α ∈ {0.1, 0.2, 0.3, 0.5, 0.7} and, **for each day**, uses the α that best predicted the 42 days before that day. The live forecast uses the α that wins today. Because each backtest prediction only ever sees the past, the reported accuracy is honest.

### Ranges and accuracy

Over the last 42 days, ccpulse records the ratio `actual / predicted`. The 10th and 90th percentiles of that ratio become the 80% band around every forecast. Next to it, ccpulse reports:
- **average daily error** (WAPE = Σ|actual − predicted| / Σ actual);
- **coverage**: how often reality actually fell inside the band.

### Periods

- **Today:** what's done so far, plus the rest of the day. The rest is `forecast(today) × (profile for the remaining hours / profile for the whole day)`.
- **Week, month, next month:** completed days, plus today's remainder, plus daily forecasts for the remaining days.
- **Weekly trend:** a linear fit over the last 8 complete weeks, reported with R² so you can see when the trend is noise.

## 7. Anomaly detection

Agent usage is bursty and full of zero hours. Mean ± k·σ flags half your working day, and median ± MAD collapses to zero. ccpulse scores against quantiles instead:

```
score = (x − p50) / max(p90 − p50, floor)
```

| Kind | Compared with | Flag when |
|---|---|---|
| Hour | the same hour of day over the previous 28 days | score ≥ `alerts.anomalyZ` (default 4) and x ≥ `alerts.anomalyMin` |
| Day | the previous 56 days | score ≥ 0.75 × anomalyZ and x ≥ 5 × anomalyMin |
| Working session | that project's sessions in the last 90 days (all sessions if the project has < 10) | above both 4 × p90 and the global p99 |

- A **working session** is a session split wherever it was idle for 2 hours or more. Long-lived or resumed sessions (bots, `--resume`) are judged one burst at a time.
- Inside a day that is already anomalous, only its two strongest hours are kept.
- **Severity:** `notice`, `high` or `extreme`, by how far past the threshold the score lands.
- **Drivers:** each anomaly lists the project, model and session that contributed the most.

## 8. Insights

Insights are short, data-backed observations. ccpulse only shows one when it's meaningful (for example, week-over-week changes under 15% are skipped):

- **Peak hours** and the share of a typical day they carry.
- **Heaviest / lightest weekday** from the typical-week heatmap.
- **Week-over-week** change at the *same point* in the week, a fair comparison mid-week.
- **Trend** when the 8-week fit has R² ≥ 0.3.
- **Model mix** by usage weight, this week vs. last.
- **What-if:** last week's top expensive-model traffic re-priced on the cheaper sibling.
- **Prompt cache hit rate** and how much caching saved.
- **Sessions per day**, cost per session, active hours, and the output share of tokens.
- **Biggest riser** among projects.
- **Cycle warnings** when a limit is projected before reset (never from history-based limits).

## 9. Plan detection and value

Claude Code keeps plan metadata in `~/.claude.json` (`oauthAccount`) and `~/.claude/.credentials.json`. ccpulse reads only these fields:
- `organizationType` and `subscriptionType`, which give Pro, Max, Team or Enterprise;
- `rateLimitTier`, for example `default_claude_max_20x`, which gives the multiplier;
- `planDisplayName`, `billingType` and `hasExtraUsageEnabled`;
- `subscriptionCreatedAt`.

Environment and settings show whether Claude Code is billing an API key, an `apiKeyHelper`, Bedrock, Vertex or Foundry. Tokens, e-mail addresses and names are never read into any output.

**Billing cycle.** Stripe renews on the subscription's start timestamp each month (UTC), clamped to short months. `plan.billingDay` overrides it.

**Value.** Your Claude Code usage in the cycle, priced at API list rates, then:
- the projected value at renewal = actual so far + today's remainder + the daily forecast;
- multiple = value ÷ price.

The price is your tier's list price unless you set `plan.monthlyPrice`.

**Advice** uses real plan-meter readings: the peak utilization of each weekly cycle over the last 4 weeks. Limits scale roughly with the tier (Max 5x ≈ ¼ of Max 20x), so:

| Situation | Advice |
|---|---|
| ≥ 2 of the last 4 weeks at ≥ 95% | upgrade, enable extra usage, or move routine work to cheaper models |
| Max 20x with the 90th-percentile weekly peak < 20% | Max 5x would have covered it |
| Max 5x with the 90th-percentile weekly peak < 15% | check Pro |
| fewer than 2 weekly cycles observed | not enough data yet |

## 10. Limit risk: Monte Carlo

A pace of 1.3× on Monday morning doesn't mean you'll run out. It depends on the rest of your week. ccpulse simulates the rest of every cycle that has a real 100% mark, 2,000 times, with a seeded generator so the same data gives the same answer.

**Weekly windows.** Each simulated day draws an intensity multiplier `actual day ÷ expected day` from your last 56 days. This is a block bootstrap by day, so bursty days stay bursty. The draw is applied to your learned hour-of-week profile ([§5](#5-your-profile)). The current day blends 60% of the last 24 hours' observed intensity with 40% of a draw. Per-model windows scale by that model family's recent share.

**5-hour windows.** A two-state Markov chain is learned from the last 30 days of hours:
- `P(active → active)` and `P(idle → active)`;
- hourly costs drawn from real active hours.

The live burn rate only shapes the current hour, so one hot minute can't dominate a 5-hour projection.

**Outputs:**
- `P(hit before reset)`;
- the 10th, 50th and 90th percentile of usage at reset;
- the median time of reaching 100% among the futures that do;
- a projection fan for the burn-down chart.

The simulation's median replaces the point projection, and **status comes from probability**:

| Status | Condition |
|---|---|
| critical | P ≥ 50% or ≥ 90% used |
| warn | P ≥ 20% or ≥ 75% used |
| watch | P ≥ 5% or pace ≥ `alerts.pace` |

## 11. Deep analytics

All computed over the last 30 days (`ccpulse analyze`, and the Deep analytics section of the dashboard).

| Metric | Definition |
|---|---|
| **Cost anatomy** | Each response's cost split into uncached input, output (and its thinking part), 5-minute and 1-hour cache writes, and cache reads. "Without caching" re-prices every prompt token at the input rate |
| **Prompt size** | input + cache write + cache read tokens per request: p50, p90, p99 |
| **Requests over 200k** | Share of requests, and of cost, with prompts above 200k tokens (long-context tiers and heavy re-reads) |
| **Context growth** | Median, across sessions with ≥ 10 main-thread requests, of the linear slope of prompt size per turn |
| **Re-read above 100k** | Cache-read cost of the context beyond 100k tokens: roughly what earlier `/compact` or `/clear` saves |
| **Cache reuse** | Cache reads ÷ cache writes: how many times each cached token is read back |
| **Working sessions** | A session split at idle gaps of 2 hours or more, with at least 2 requests. Single-request runs are counted separately as one-shot automations |
| **Breakdowns** | Share of cost and cost per request by effort level, main thread vs. subagents (sidechains and `subagents/` logs), and entry point (`cli`, `claude-desktop`, `sdk-ts`, …) |
| **Model mix** | Weekly share of usage weight for the top 4 models plus "other" |
| **Concentration** | Top-project and top-3 shares, and the Herfindahl–Hirschman index over projects (1 / HHI = "effective number of projects") |
| **Regime change** | The single most significant level shift in daily usage over 90 days: a split point with ≥ 7 days on each side, maximizing a Welch t statistic on `log1p(daily)`. It is reported when t ≥ 4 and the median moved ≥ 30% |

Findings that matter become insights automatically. Examples: "52% of cost comes from 200k+ context", "cache writes are 53% of cost", "subagents are 30% of cost".

## 12. Organization API analytics

With an Admin API key, ccpulse reads the [Usage and Cost Analytics API](https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api) through the official SDK (`client.beta.organization.analytics.cost/usage.list`):
- daily buckets grouped by model, workspace, API key and product, paged in windows of at most 31 days;
- API keys, workspaces, rate limits and spend limits.

The daily spend series goes through the same online-tuned forecaster as your own usage. Budgets use the same pace logic as plan cycles, on the calendar month. Details and commands: [api.md](api.md).

## 13. Performance

| | |
|---|---|
| First run | ~40 s for ~5 GB / 20k files (one streaming pass, JSON parsed only for assistant lines with usage) |
| Later runs | ~2 s (read the appended tail, load the gzip index, analyze ~100k responses) |
| Status line | ~50 ms (60 s result cache) |
| Monte Carlo | 2,000 simulations × each cycle, well under a second |
| Package | ~85 kB, no required runtime dependencies (the Anthropic SDK is optional, for API commands) |
