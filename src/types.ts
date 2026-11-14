/** One deduplicated assistant response with token usage. */
export interface Entry {
  /** Epoch milliseconds (UTC). */
  t: number;
  /** Normalized model id, e.g. `claude-opus-5.5`. */
  model: string;
  /** Project label (last segment of the working directory). */
  project: string;
  sessionId: string;
  input: number;
  output: number;
  /** Cache writes with the 5-minute TTL. */
  cacheWrite5m: number;
  /** Cache writes with the 1-hour TTL (priced at 2x input). */
  cacheWrite1h: number;
  cacheRead: number;
  /** `fast` when Claude Code ran in fast mode. */
  speed?: string;
  /** API-equivalent cost in USD. */
  cost: number;
}

export interface Totals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  tokens: number;
  cost: number;
  requests: number;
}

export type Granularity = 'hour' | 'day' | 'week' | 'month';

export interface Bucket extends Totals {
  /** Bucket start, epoch ms. */
  start: number;
  /** Human label in the configured time zone. */
  label: string;
}

export type Metric = 'cost' | 'tokens';

export function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, tokens: 0, cost: 0, requests: 0 };
}

export function addEntry(t: Totals, e: Entry): void {
  const cw = e.cacheWrite5m + e.cacheWrite1h;
  t.input += e.input;
  t.output += e.output;
  t.cacheWrite += cw;
  t.cacheRead += e.cacheRead;
  t.tokens += e.input + e.output + cw + e.cacheRead;
  t.cost += e.cost;
  t.requests += 1;
}

export function metricOf(t: Totals, m: Metric): number {
  return m === 'cost' ? t.cost : t.tokens;
}
