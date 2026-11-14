export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function median(xs: number[]): number {
  return quantile(xs, 0.5);
}

/** Median absolute deviation, scaled to be comparable with a standard deviation. */
export function mad(xs: number[]): number {
  if (!xs.length) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/** Robust z-score; `floor` keeps tiny-variance baselines from flagging noise. */
export function robustZ(x: number, xs: number[], floor = 0): number {
  const m = median(xs);
  const s = Math.max(mad(xs), floor, 1e-9);
  return (x - m) / s;
}

/** Exponentially weighted mean, most recent value last. */
export function ewma(xs: number[], alpha: number): number {
  if (!xs.length) return 0;
  let v = xs[0];
  for (let i = 1; i < xs.length; i++) v = alpha * xs[i] + (1 - alpha) * v;
  return v;
}

/** Ordinary least squares slope/intercept for y over x = 0..n-1. */
export function linearTrend(ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
  const mx = (n - 1) / 2;
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (ys[i] - my);
    sxx += (i - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, intercept: my - slope * mx, r2 };
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function pctChange(now: number, before: number): number | undefined {
  if (!before) return undefined;
  return (now - before) / before;
}
