#!/usr/bin/env node
// Regenerates every image in docs/images from `--demo` data (never from real logs).
// Requires Google Chrome / Chromium. Usage: npm run shots
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'docs', 'images');
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(path.join(tmpdir(), 'ccpulse-shots-'));
const TZ = 'America/New_York';
const chrome = ['google-chrome', 'chromium', 'chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
if (!chrome) throw new Error('Chrome or Chromium is required');

function shoot(url, file, w, h, scale = 2) {
  execFileSync(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--force-device-scale-factor=${scale}`, '--virtual-time-budget=10000', `--window-size=${w},${h}`,
    `--screenshot=${file}`, url,
  ], { stdio: 'ignore' });
  console.log('✓', path.relative(root, file));
}

// Inter from Google Fonts; JetBrains Mono as the full (unsubset) webfont so block and
// box-drawing characters (bars, sparklines, table rules) render in the same face.
const JBM = 'https://cdn.jsdelivr.net/gh/JetBrains/JetBrainsMono@2.304/fonts/webfonts';
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=block" rel="stylesheet">
<style>@font-face{font-family:JBM;src:url(${JBM}/JetBrainsMono-Regular.woff2) format('woff2');font-weight:400;font-display:block}
@font-face{font-family:JBM;src:url(${JBM}/JetBrainsMono-Bold.woff2) format('woff2');font-weight:700;font-display:block}</style>`;
const MARK = readFileSync(path.join(root, 'assets', 'mark.svg'), 'utf8');

// ---------- terminal captures ----------
const ANSI = { 31: '#ff7b72', 32: '#56d364', 33: '#e3b341', 34: '#79c0ff', 35: '#d2a8ff', 36: '#56d4dd', 90: '#6e7681' };
function ansiToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let color = null, bold = false, dim = false, html = '';
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) {
      if (!part) continue;
      const style = [color ? `color:${color}` : '', bold ? 'font-weight:700' : '', dim ? 'opacity:.55' : ''].filter(Boolean).join(';');
      html += style ? `<span style="${style}">${esc(part)}</span>` : esc(part);
      continue;
    }
    for (const c of m[1].split(';').map(Number)) {
      if (c === 0) [color, bold, dim] = [null, false, false];
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) [bold, dim] = [false, false];
      else if (c === 39) color = null;
      else if (ANSI[c]) color = ANSI[c];
    }
  }
  return html;
}
function terminal(name, args, title) {
  const env = { ...process.env, FORCE_COLOR: '1', COLUMNS: '120' };
  const txt = execFileSync('node', [path.join(root, 'dist', 'cli.js'), ...args, '--demo', '--tz', TZ], { env, encoding: 'utf8' }).replace(/\n+$/, '');
  const lines = txt.split('\n');
  const cols = Math.max(...lines.map((l) => [...l.replace(/\x1b\[[0-9;]*m/g, '')].length));
  const W = Math.max(720, Math.ceil(cols * 9) + 2 * 28 + 2 * 48);
  const H = lines.length * 22 + 52 + 2 * 22 + 2 * 48;
  const html = `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
    body{margin:0;background:linear-gradient(135deg,#1d3a70 0%,#0d1730 55%,#3a1f2e 100%);padding:48px;font-family:Inter,sans-serif}
    .win{background:#0d1117;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08);overflow:hidden}
    .bar{height:52px;display:flex;align-items:center;padding:0 18px;gap:8px;background:#161b22;border-bottom:1px solid #21262d}
    .dot{width:12px;height:12px;border-radius:50%}
    .ttl{flex:1;text-align:center;color:#8b949e;font-size:13px;margin-right:52px}
    pre{margin:0;padding:22px 28px;font:15px/22px JBM,monospace;color:#e6edf3;white-space:pre}
    .p{color:#56d364}</style></head><body><div class="win"><div class="bar"><i class="dot" style="background:#ff5f57"></i><i class="dot" style="background:#febc2e"></i><i class="dot" style="background:#28c840"></i><div class="ttl">${title}</div></div>
    <pre><span class="p">❯</span> ccpulse ${args.join(' ')}\n${ansiToHtml(txt)}</pre></div></body></html>`;
  const f = path.join(tmp, `${name}.html`);
  writeFileSync(f, html);
  shoot(`file://${f}`, path.join(out, `${name}.png`), W, Math.ceil(H + 22));
}

terminal('cli-overview', [], 'ccpulse: overview');
terminal('cli-pace', ['pace'], 'ccpulse pace');
terminal('cli-forecast', ['forecast'], 'ccpulse forecast');
terminal('cli-insights', ['insights'], 'ccpulse insights');
terminal('cli-anomalies', ['anomalies'], 'ccpulse anomalies');
terminal('cli-report', ['report', 'daily', '-n', '10', '--by', 'model'], 'ccpulse report daily');
terminal('cli-statusline', ['statusline'], 'Claude Code status line');

// ---------- dashboard ----------
const port = 4499;
const server = spawn('node', [path.join(root, 'dist', 'cli.js'), 'dashboard', '--demo', '--tz', TZ, '--port', String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
try {
  for (const theme of ['light', 'dark']) {
    const url = `http://127.0.0.1:${port}/?theme=${theme}&g=day`;
    shoot(url, path.join(tmp, `dash-${theme}.png`), 1360, 1500);
  }
  shoot(`http://127.0.0.1:${port}/?theme=dark&g=hour`, path.join(tmp, 'dash-hour.png'), 1360, 1500);
} finally {
  server.kill();
}

// Framed browser window around a dashboard capture.
function framed(name, img, title, bg) {
  const html = `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
    body{margin:0;padding:56px;background:${bg};font-family:Inter,sans-serif}
    .win{border-radius:14px;overflow:hidden;box-shadow:0 40px 100px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.12)}
    .bar{height:44px;background:#e8e8e6;display:flex;align-items:center;gap:8px;padding:0 16px}
    .dark .bar{background:#202124}
    .dot{width:12px;height:12px;border-radius:50%}
    .url{flex:1;margin:0 70px 0 24px;height:26px;border-radius:13px;background:rgba(255,255,255,.75);font-size:12.5px;color:#555;display:flex;align-items:center;justify-content:center}
    .dark .url{background:#35363a;color:#bbb}
    img{display:block;width:100%}</style></head><body><div class="win ${title.includes('dark') ? 'dark' : ''}">
    <div class="bar"><i class="dot" style="background:#ff5f57"></i><i class="dot" style="background:#febc2e"></i><i class="dot" style="background:#28c840"></i><div class="url">127.0.0.1:4477</div></div>
    <img src="file://${img}"></div></body></html>`;
  const f = path.join(tmp, `${name}.html`);
  writeFileSync(f, html);
  shoot(`file://${f}`, path.join(out, `${name}.png`), 1360 + 112, Math.round(1500 + 44 + 112));
}
framed('dashboard-light', path.join(tmp, 'dash-light.png'), 'light', 'linear-gradient(135deg,#dbe9fb 0%,#f5f3ef 60%,#fde5d9 100%)');
framed('dashboard-dark', path.join(tmp, 'dash-dark.png'), 'dark', 'linear-gradient(135deg,#1d3a70 0%,#0d1730 55%,#3a1f2e 100%)');
framed('dashboard-hourly', path.join(tmp, 'dash-hour.png'), 'dark', 'linear-gradient(135deg,#1d3a70 0%,#0d1730 55%,#3a1f2e 100%)');

// ---------- brand ----------
function brand(name, w, h, theme, body) {
  const fg = theme === 'dark' ? '#f0efec' : '#0b0b0b';
  const sub = theme === 'dark' ? '#a9b1bc' : '#52514e';
  const html = `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
    body{margin:0;width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;background:transparent;font-family:Inter,sans-serif;color:${fg}}
    .sub{color:${sub}}</style></head><body>${body}</body></html>`;
  const f = path.join(tmp, `${name}.html`);
  writeFileSync(f, html);
  execFileSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', '--force-device-scale-factor=2', '--virtual-time-budget=8000', `--window-size=${w},${h}`, `--screenshot=${path.join(out, name + '.png')}`, `file://${f}`], { stdio: 'ignore' });
  console.log('✓', `docs/images/${name}.png`);
}
const wordmark = (theme) => `<div style="display:flex;align-items:center;gap:26px">
  <div style="width:112px;height:112px">${MARK.replace('width="128" height="128"', 'width="112" height="112"')}</div>
  <div><div style="font-size:84px;font-weight:800;letter-spacing:-0.045em;line-height:1">cc<span style="background:linear-gradient(90deg,#3f8ef0,#6fb8ff);-webkit-background-clip:text;color:transparent">pulse</span></div>
  <div class="sub" style="font-size:22px;font-weight:500;margin-top:10px;letter-spacing:-0.01em">Usage intelligence for Claude Code</div></div></div>`;
brand('logo-light', 760, 180, 'light', wordmark('light'));
brand('logo-dark', 760, 180, 'dark', wordmark('dark'));

// Social preview (1280×640) for GitHub settings → Social preview.
{
  const html = `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
    body{margin:0;width:1280px;height:640px;overflow:hidden;font-family:Inter,sans-serif;color:#f0efec;
      background:radial-gradient(900px 500px at 85% 110%,rgba(255,138,92,.28),transparent 60%),radial-gradient(900px 600px at 0% 0%,rgba(63,142,240,.35),transparent 60%),#0b1224}
    .l{position:absolute;left:84px;top:96px;width:560px}
    h1{font-size:92px;font-weight:800;letter-spacing:-0.05em;margin:28px 0 0;line-height:1}
    h1 span{background:linear-gradient(90deg,#3f8ef0,#7cc2ff);-webkit-background-clip:text;color:transparent}
    p{font-size:30px;line-height:1.3;color:#c6cfdb;margin:22px 0 0;letter-spacing:-0.01em}
    .tags{margin-top:34px;display:flex;flex-wrap:wrap;gap:10px}
    .tags b{font-weight:500;font-size:18px;color:#dfe6ef;border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:7px 16px;background:rgba(255,255,255,.04)}
    .shot{position:absolute;left:690px;top:70px;width:900px;border-radius:14px;box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.1);transform:rotate(-2deg)}
    </style></head><body>
    <img class="shot" src="file://${path.join(tmp, 'dash-dark.png')}">
    <div class="l"><div style="width:120px;height:120px">${MARK.replace('width="128" height="128"', 'width="120" height="120"')}</div>
    <h1>cc<span>pulse</span></h1><p>Understand, learn from and forecast your Claude Code usage.</p>
    <div class="tags"><b>Cycle pace</b><b>Forecasts</b><b>Anomalies</b><b>Alerts</b></div></div></body></html>`;
  const f = path.join(tmp, 'social.html');
  writeFileSync(f, html);
  shoot(`file://${f}`, path.join(out, 'social-preview.png'), 1280, 640, 1);
}
console.log('done →', path.relative(root, out));

// Optional: shrink screenshots ~70% with a 256-color palette (needs Python + Pillow).
try {
  execFileSync('python3', ['-c', `
from PIL import Image; import glob
for f in glob.glob(${JSON.stringify(out + '/*.png')}):
    if 'logo' in f or 'social' in f: continue
    Image.open(f).convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f, optimize=True)
`], { stdio: 'ignore' });
  console.log('✓ compressed');
} catch {
  console.log('(skipped compression: python3 + Pillow not found)');
}
