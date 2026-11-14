import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirs } from './paths.js';

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  /** 5-minute cache write. 1-hour cache writes are billed at 2x input. */
  cacheWrite: number;
  cacheRead: number;
  /** Long-context tier, applied when the prompt exceeds `threshold` tokens. */
  above?: { threshold: number; input: number; output: number; cacheWrite: number; cacheRead: number };
}

let table: Record<string, Price> | undefined;

function loadTable(): Record<string, Price> {
  if (table) return table;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = JSON.parse(readFileSync(path.join(here, 'pricing-data.json'), 'utf8')) as Record<string, Price>;
  // Users can override or add models without waiting for a release.
  const override = path.join(dirs.config(), 'pricing.json');
  if (existsSync(override)) {
    try {
      Object.assign(bundled, JSON.parse(readFileSync(override, 'utf8')));
    } catch {
      process.stderr.write(`ccpulse: ignoring unreadable ${override}\n`);
    }
  }
  table = bundled;
  return table;
}

const ALIASES: Record<string, string> = {
  opus: 'claude-opus-5.5',
  sonnet: 'claude-sonnet-5.5',
  haiku: 'claude-haiku-5.5',
  fable: 'claude-fable-5.2',
};

/** `claude-opus-5-5-20261001` → `claude-opus-5.5`; `claude-3-5-sonnet` → `claude-sonnet-3.5`. */
export function normalizeModel(raw: string | undefined): string {
  if (!raw) return 'unknown';
  let m = raw.trim().toLowerCase();
  if (ALIASES[m]) return ALIASES[m];
  m = m.replace(/^anthropic[./]/, '').replace(/^(us|eu|apac|global)\.anthropic\./, '');
  m = m.replace(/-v\d+(:\d+)?$/, '').replace(/@\d{8}$/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
  // Legacy order: claude-3-5-sonnet → claude-sonnet-3.5
  const legacy = m.match(/^claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)$/);
  if (legacy) m = `claude-${legacy[3]}-${legacy[1]}${legacy[2] ? '.' + legacy[2] : ''}`;
  m = m.replace(/^(claude-[a-z]+-\d)-(\d)(?=$|-)/, '$1.$2');
  return m;
}

export function priceFor(model: string, speed?: string): Price | undefined {
  const t = loadTable();
  if (speed === 'fast' && t[`${model}-fast`]) return t[`${model}-fast`];
  if (t[model]) return t[model];
  // Fall back to the family's major version (claude-opus-5.3 → claude-opus-5).
  const major = model.replace(/^(claude-[a-z]+-\d)\.\d+$/, '$1');
  return t[major];
}

const unknownModels = new Set<string>();
export function unknownPricedModels(): string[] {
  return [...unknownModels];
}

export function costOf(
  model: string,
  u: { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number },
  speed?: string,
): number {
  const p = priceFor(model, speed);
  if (!p) {
    if (model !== 'unknown' && model !== '<synthetic>') unknownModels.add(model);
    return 0;
  }
  const prompt = u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;
  const r = p.above && prompt > p.above.threshold ? p.above : p;
  return (
    (u.input * r.input +
      u.output * r.output +
      u.cacheWrite5m * r.cacheWrite +
      u.cacheWrite1h * r.input * 2 +
      u.cacheRead * r.cacheRead) /
    1_000_000
  );
}
