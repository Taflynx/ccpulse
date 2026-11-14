// Claude Code renders ANSI in the status line even though stdout is a pipe there.
const enabled =
  !process.env.NO_COLOR &&
  !process.argv.includes('--no-color') &&
  (process.stdout.isTTY || !!process.env.FORCE_COLOR || process.argv.includes('statusline'));

const wrap = (open: number, close = 39) => (s: string | number) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: (s: string | number) => (enabled ? `\x1b[1m${s}\x1b[22m` : String(s)),
  dim: (s: string | number) => (enabled ? `\x1b[2m${s}\x1b[22m` : String(s)),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  gray: wrap(90),
};

const ANSI = /\x1b\[[0-9;]*m/g;
export function width(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, '')) {
    const cp = ch.codePointAt(0)!;
    w += cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff)) ? 2 : 1;
  }
  return w;
}

export function padEnd(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - width(s)));
}
export function padStart(s: string, n: number): string {
  return ' '.repeat(Math.max(0, n - width(s))) + s;
}

export function table(head: string[], rows: string[][], align: ('l' | 'r')[] = []): string {
  const w = head.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
  const line = (cells: string[]) => cells.map((x, i) => (align[i] === 'r' ? padStart(x, w[i]) : padEnd(x, w[i]))).join('  ');
  return [c.bold(line(head)), c.gray(w.map((n) => '─'.repeat(n)).join('  ')), ...rows.map(line)].join('\n');
}

const BLOCKS = '▁▂▃▄▅▆▇█';
export function sparkline(values: number[], max = Math.max(...values, 0)): string {
  if (!values.length) return '';
  return values.map((v) => (v <= 0 || max <= 0 ? c.gray('·') : BLOCKS[Math.min(7, Math.floor((v / max) * 7.999))])).join('');
}

/** Progress bar with an elapsed-time marker: █ used, │ where you "should" be. */
export function paceBar(used: number | undefined, elapsed: number, cells = 30): string {
  const u = Math.max(0, Math.min(1, used ?? 0));
  const filled = Math.round(u * cells);
  const mark = Math.min(cells - 1, Math.max(0, Math.round(elapsed * cells)));
  let s = '';
  for (let i = 0; i < cells; i++) {
    const ch = i < filled ? '█' : '░';
    if (i === mark) s += c.bold(i < filled ? '▓' : '│');
    else s += ch;
  }
  const color = used === undefined ? c.gray : used >= 0.9 ? c.red : used > elapsed * 1.15 ? c.yellow : c.green;
  return color(s);
}

export function money(v: number): string {
  if (!Number.isFinite(v)) return '-';
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  if (Math.abs(v) >= 100) return `$${v.toFixed(0)}`;
  return `$${v.toFixed(2)}`;
}

export function tokens(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

export function pct(v: number | undefined, digits = 0): string {
  return v === undefined || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(digits)}%`;
}

export function signed(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return c.gray('-');
  const s = `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
  return v > 0.15 ? c.yellow(s) : v < -0.15 ? c.cyan(s) : c.gray(s);
}

export function statusBadge(s: string): string {
  switch (s) {
    case 'critical':
      return c.red('● critical');
    case 'warn':
      return c.yellow('● fast');
    case 'watch':
      return c.yellow('○ watch');
    case 'idle':
      return c.gray('○ idle');
    default:
      return c.green('● on pace');
  }
}

/** Word-wrap plain text to the terminal width (capped for readability), indenting continuation lines. */
export function wordWrap(text: string, indent = 2, max = Math.min(process.stdout.columns || 100, 110)): string {
  const width = Math.max(40, max - indent);
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.map((l) => ' '.repeat(indent) + l).join('\n');
}
