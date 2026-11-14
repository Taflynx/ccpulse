import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Claude Code data roots, following the same rules as ccusage:
 * `CLAUDE_CONFIG_DIR` (comma-separated, each a config dir or its `projects/`),
 * otherwise `~/.config/claude/projects` and `~/.claude/projects`.
 */
export function claudeProjectDirs(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const candidates: string[] = [];
  if (env && env.trim()) {
    for (const raw of env.split(',')) {
      const p = raw.trim();
      if (!p) continue;
      candidates.push(path.basename(p) === 'projects' ? p : path.join(p, 'projects'));
    }
  } else {
    const home = homedir();
    candidates.push(path.join(home, '.config', 'claude', 'projects'));
    candidates.push(path.join(home, '.claude', 'projects'));
  }
  const seen = new Set<string>();
  return candidates.filter((p) => {
    try {
      if (!statSync(p).isDirectory()) return false;
    } catch {
      return false;
    }
    const real = path.resolve(p);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

function xdg(envName: string, fallback: string): string {
  const v = process.env[envName];
  return v && path.isAbsolute(v) ? v : path.join(homedir(), fallback);
}

export const dirs = {
  config: () => path.join(xdg('XDG_CONFIG_HOME', '.config'), 'ccpulse'),
  cache: () => path.join(xdg('XDG_CACHE_HOME', '.cache'), 'ccpulse'),
  state: () => path.join(xdg('XDG_STATE_HOME', path.join('.local', 'state')), 'ccpulse'),
};

export function claudeCredentialsFile(): string | undefined {
  const roots = process.env.CLAUDE_CONFIG_DIR
    ? process.env.CLAUDE_CONFIG_DIR.split(',').map((s) => s.trim().replace(/\/projects\/?$/, ''))
    : [path.join(homedir(), '.claude'), path.join(homedir(), '.config', 'claude')];
  for (const r of roots) {
    const f = path.join(r, '.credentials.json');
    if (existsSync(f)) return f;
  }
  return undefined;
}
