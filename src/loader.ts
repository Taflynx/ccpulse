import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { claudeProjectDirs, dirs } from './paths.js';
import { costOf, normalizeModel } from './pricing.js';
import type { Entry } from './types.js';

/**
 * Compact row as stored in the incremental cache:
 * [t, model, speed, sessionId, project, input, output, cw5m, cw1h, cacheRead, messageId, requestId, sidechain,
 *  thinkingTokens, effort, entrypoint, subagent, webSearchRequests]
 */
export type Row = [
  number, string, string, string, string, number, number, number, number, number, string, string, 0 | 1,
  number, string, string, 0 | 1, number,
];

interface FileState {
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last complete line that was parsed. */
  offset: number;
  rows: Row[];
}

interface CacheFile {
  version: number;
  files: Record<string, FileState>;
}

const CACHE_VERSION = 2;

function cachePath(): string {
  return path.join(dirs.cache(), `entries-v${CACHE_VERSION}.json.gz`);
}

function readCache(): CacheFile {
  const p = cachePath();
  if (!existsSync(p)) return { version: CACHE_VERSION, files: {} };
  try {
    const c = JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')) as CacheFile;
    if (c.version === CACHE_VERSION && c.files) return c;
  } catch {
    // Corrupt cache: rebuild.
  }
  return { version: CACHE_VERSION, files: {} };
}

function writeCache(c: CacheFile): void {
  const p = cachePath();
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, gzipSync(JSON.stringify(c), { level: 1 }));
  renameSync(tmp, p);
}

async function walk(dir: string, out: string[]): Promise<void> {
  let list;
  try {
    list = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

/** `-home-user-dev-myproj` (Claude's encoded dir) → best-effort readable label. */
function projectFromPath(root: string, file: string): string {
  const rel = path.relative(root, file).split(path.sep)[0] ?? 'unknown';
  return rel.replace(/^-/, '').split('-').filter(Boolean).slice(-1)[0] ?? rel;
}

export function parseLine(line: string, fallbackProject: string, subagentFile = false): Row | undefined {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return undefined;
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return undefined;
  }
  const msg = j?.message;
  const u = msg?.usage;
  if (j?.type !== 'assistant' || !u || typeof j.timestamp !== 'string') return undefined;
  const t = Date.parse(j.timestamp);
  if (!Number.isFinite(t)) return undefined;
  const model = String(msg.model ?? '');
  if (model === '<synthetic>') return undefined;
  const cc = u.cache_creation;
  const cwTotal = num(u.cache_creation_input_tokens);
  const cw1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const cw5m = cc ? Math.max(0, cwTotal - cw1h) : cwTotal;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  if (input + output + cwTotal + cacheRead === 0) return undefined;
  const project = typeof j.cwd === 'string' && j.cwd ? path.basename(j.cwd) : fallbackProject;
  return [
    t,
    model,
    typeof u.speed === 'string' ? u.speed : '',
    String(j.sessionId ?? ''),
    project,
    input,
    output,
    cw5m,
    cw1h,
    cacheRead,
    String(msg.id ?? ''),
    String(j.requestId ?? ''),
    j.isSidechain === true ? 1 : 0,
    num(u.output_tokens_details?.thinking_tokens),
    typeof j.effort === 'string' ? j.effort : '',
    typeof j.entrypoint === 'string' ? j.entrypoint : '',
    subagentFile || j.isSidechain === true || typeof j.agentId === 'string' ? 1 : 0,
    num(u.server_tool_use?.web_search_requests),
  ];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Parse `file` from `start`, returning new rows and the offset after the last full line. */
async function parseFrom(file: string, start: number, project: string): Promise<{ rows: Row[]; offset: number }> {
  const sub = file.includes(`${path.sep}subagents${path.sep}`);
  const rows: Row[] = [];
  let offset = start;
  let carry = '';
  const stream = createReadStream(file, { start, encoding: 'utf8', highWaterMark: 1 << 20 });
  for await (const chunk of stream as AsyncIterable<string>) {
    const text = carry + chunk;
    let from = 0;
    let nl: number;
    while ((nl = text.indexOf('\n', from)) !== -1) {
      const line = text.slice(from, nl);
      offset += Buffer.byteLength(line, 'utf8') + 1;
      const r = parseLine(line, project, sub);
      if (r) rows.push(r);
      from = nl + 1;
    }
    carry = text.slice(from);
  }
  // A trailing line without newline may still be in the middle of being written:
  // only take it if it parses, and do not advance the offset past it.
  if (carry.trim()) {
    const r = parseLine(carry, project, sub);
    if (r) rows.push(r);
  }
  return { rows, offset };
}

export interface LoadResult {
  entries: Entry[];
  files: number;
  parsedFiles: number;
  ms: number;
}

export interface LoadOptions {
  /** Ignore and rebuild the cache. */
  fresh?: boolean;
  /** Print progress to stderr on long first runs. */
  progress?: boolean;
}

export async function loadEntries(opts: LoadOptions = {}): Promise<LoadResult> {
  const t0 = Date.now();
  const roots = claudeProjectDirs();
  const cache = opts.fresh ? { version: CACHE_VERSION, files: {} } : readCache();
  const next: CacheFile = { version: CACHE_VERSION, files: {} };
  let parsedFiles = 0;
  let total = 0;
  const all: { file: string; root: string }[] = [];
  for (const root of roots) {
    const files: string[] = [];
    await walk(root, files);
    for (const f of files) all.push({ file: f, root });
  }
  let lastProgress = Date.now();
  for (const { file, root } of all) {
    total++;
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    const prev = cache.files[file];
    const project = projectFromPath(root, file);
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
      next.files[file] = prev;
      continue;
    }
    parsedFiles++;
    if (prev && st.size > prev.size && prev.offset <= st.size) {
      // Append-only growth: parse only the new tail. Drop rows that came from an
      // unterminated last line, which we re-read from `prev.offset`.
      const kept = prev.rows;
      const { rows, offset } = await parseFrom(file, prev.offset, project);
      const keys = new Set(kept.map(rowKey));
      next.files[file] = {
        size: st.size,
        mtimeMs: st.mtimeMs,
        offset,
        rows: kept.concat(rows.filter((r) => !keys.has(rowKey(r)))),
      };
    } else {
      const { rows, offset } = await parseFrom(file, 0, project);
      next.files[file] = { size: st.size, mtimeMs: st.mtimeMs, offset, rows };
    }
    if (opts.progress && Date.now() - lastProgress > 1500) {
      lastProgress = Date.now();
      process.stderr.write(`\rccpulse: indexing Claude Code logs… ${total}/${all.length} files`);
    }
  }
  if (opts.progress && parsedFiles > 200) process.stderr.write('\r\x1b[K');
  if (parsedFiles > 0 || Object.keys(cache.files).length !== Object.keys(next.files).length) writeCache(next);

  const entries = dedupe(Object.values(next.files).flatMap((f) => f.rows));
  return { entries, files: total, parsedFiles, ms: Date.now() - t0 };
}

function rowKey(r: Row): string {
  return `${r[10]}|${r[11]}|${r[0]}`;
}

/**
 * Deduplicate like ccusage:
 * - Claude Code writes one line per content block of a response; they share message id + request id.
 * - Sidechain logs (`/btw`, subagent replays) can replay a parent message under the same message id
 *   with a different request id: keep the parent copy.
 * - Without a request id, real `msg_` ids still collapse; gateway placeholder ids also key on session+timestamp.
 */
export function dedupe(rows: Row[]): Entry[] {
  const mainIds = new Set<string>();
  for (const r of rows) if (!r[12] && r[10]) mainIds.add(r[10]);
  const seen = new Set<string>();
  const out: Entry[] = [];
  rows.sort((a, b) => a[0] - b[0] || a[12] - b[12]);
  for (const r of rows) {
    const [t, rawModel, speed, sessionId, project, input, output, cw5m, cw1h, cacheRead, msgId, reqId, side, thinking, effort, entrypoint, subagent, webSearch] = r;
    if (side && msgId && mainIds.has(msgId)) continue;
    let key: string;
    if (reqId) key = `${msgId}|${reqId}`;
    else if (msgId.startsWith('msg_') || msgId.startsWith('resp_')) key = msgId;
    else key = `${msgId}|${sessionId}|${t}`;
    if (side && msgId) key = msgId; // collapse sidechain replays among themselves
    if (seen.has(key)) continue;
    seen.add(key);
    const model = normalizeModel(rawModel);
    const u = { input, output, cacheWrite5m: cw5m, cacheWrite1h: cw1h, cacheRead };
    out.push({
      t,
      model,
      project,
      sessionId,
      ...u,
      speed: speed || undefined,
      cost: costOf(model, u, speed || undefined),
      thinking: thinking ?? 0,
      effort: effort || undefined,
      entrypoint: entrypoint || undefined,
      subagent: subagent === 1,
      webSearch: webSearch ?? 0,
    });
  }
  return out;
}
