import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import type { Config } from '../config.js';
import { analyze, type Analysis } from '../analysis.js';
import { evaluate } from '../alerts.js';
import { asset, page } from './page.js';

export async function startDashboard(cfg: Config, o: { port: number; host: string; open: boolean; offline: boolean; demo?: boolean }): Promise<void> {
  let cached: { at: number; data: Analysis & { alerts: ReturnType<typeof evaluate> } } | undefined;
  let inflight: Promise<void> | undefined;
  const refresh = async () => {
    const a = await analyze(cfg, { offline: o.offline, demo: o.demo });
    cached = { at: Date.now(), data: { ...a, alerts: evaluate(a, cfg) } };
  };
  await refresh();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Only answer requests addressed to this host, to block DNS-rebinding reads from other sites.
    const host = (req.headers.host ?? '').split(':')[0];
    if (!['127.0.0.1', 'localhost', '[::1]', o.host].includes(host)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (url.pathname === '/api/analysis') {
      if (!cached || Date.now() - cached.at > 30_000) {
        inflight ??= refresh().finally(() => (inflight = undefined));
        try {
          await inflight;
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(cached!.data));
      return;
    }
    if (url.pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }).end(asset('app.js'));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:",
        'Cache-Control': 'no-store',
      }).end(page());
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => resolve());
  });
  const url = `http://${o.host === '0.0.0.0' ? '127.0.0.1' : o.host}:${o.port}/`;
  console.log(`ccpulse dashboard: ${url}  (Ctrl+C to stop)`);
  if (o.host !== '127.0.0.1' && o.host !== 'localhost') console.log('⚠ Bound to a non-loopback address: anyone who can reach it can see your usage.');
  if (o.open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(cmd, [url], () => undefined);
  }
}
