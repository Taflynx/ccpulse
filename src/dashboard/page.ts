import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

export function asset(name: 'index.html' | 'app.js'): string {
  let s = cache.get(name);
  if (s === undefined) cache.set(name, (s = readFileSync(path.join(here, name), 'utf8')));
  return s;
}

export function page(): string {
  return asset('index.html');
}
