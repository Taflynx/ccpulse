# Contributing

Thanks for helping! ccpulse aims to stay small, dependency-free and honest about its numbers.

## Setup

```bash
git clone https://github.com/Taflynx/ccpulse && cd ccpulse
npm install
npm test                       # build + unit tests
npm run dev -- pace --demo     # run from source on synthetic data
```

## Guidelines

- **No runtime dependencies.** Node's standard library, plain TypeScript, and hand-written SVG in the dashboard.
- **Correctness first.** Changes to parsing, pricing, cycles, forecasting or anomalies need a test in `src/core.test.ts`. Keep log parsing and deduplication in line with ccusage, so daily totals match.
- **Honest numbers.** Anything predictive must say how sure it is. Never alert on a limit ccpulse doesn't actually know.
- **Privacy.** No telemetry. Network calls are limited to the plan meter and the alert channels the user configured.
- **Screenshots** come from `--demo` data only. To regenerate them, run `npm run shots` (requires Chrome or Chromium).

## Releasing

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Run `npm test`.
3. Tag `vX.Y.Z` and run `npm publish`.
