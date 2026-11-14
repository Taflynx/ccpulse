/** One plan-limit window as `ccpulse statusline --json` reports it. */
export type Cycle = {
  key: string;
  name: string;
  label: string;
  /** Share of the limit used, 0..1. */
  used: number;
  /** Share of the cycle elapsed, 0..1. */
  elapsed: number;
  pace?: number;
  /** Monte Carlo probability of hitting the limit before reset. */
  risk?: number;
  status: string;
  resetsIn: number;
  resetsAt: number;
  source: string;
};

export type Snapshot = {
  generatedAt: number;
  plan: string;
  cycles: Cycle[];
  today: { cost: number; forecast: number };
  spike: boolean;
};

declare module 'claude-code' {
  interface PluginState {
    'ccpulse-bar': { snap: Snapshot | null; error: string | null; isExpanded: boolean };
  }
}
