// ccpulse dashboard: dependency-free SVG charts fed by /api/analysis.
'use strict';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
let DATA = null;
const params = new URLSearchParams(location.search);
let gran = 'hour';
try { gran = localStorage.getItem('ccpulse.gran') || 'hour'; } catch (_) { /* storage blocked */ }
if (['hour', 'day', 'week', 'month'].includes(params.get('g'))) gran = params.get('g');
if (['deep', 'api'].includes(params.get('focus'))) document.body.dataset.focus = params.get('focus');

// ---------- formatting ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function money(v) {
  if (!isFinite(v)) return '–';
  if (Math.abs(v) >= 10000) return '$' + (v / 1000).toFixed(1) + 'K';
  if (Math.abs(v) >= 100) return '$' + Math.round(v).toLocaleString();
  return '$' + v.toFixed(2);
}
function tok(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}
const val = (v) => (DATA && DATA.metric === 'tokens' ? tok(v) : money(v));
const mval = (b) => (DATA.metric === 'tokens' ? b.tokens : b.cost);
const pct = (v, d = 0) => (v === undefined || v === null || !isFinite(v) ? '–' : (v * 100).toFixed(d) + '%');
function dur(ms) {
  const neg = ms < 0; let m = Math.round(Math.abs(ms) / 60000);
  const d = Math.floor(m / 1440); m -= d * 1440; const h = Math.floor(m / 60); m -= h * 60;
  return (neg ? '-' : '') + (d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm');
}
const fmtTime = (ts) => new Date(ts).toLocaleString([], { timeZone: DATA.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = (ts) => new Date(ts).toLocaleDateString([], { timeZone: DATA.timezone, month: 'short', day: 'numeric' });

/** Clean axis: a 1/2/2.5/5 step, top rounded up to a whole step, 3–6 ticks. */
function niceScale(v) {
  if (v <= 0) return { top: 1, step: 0.25 };
  const raw = v / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw);
  return { top: Math.ceil(v / step) * step, step };
}
function tickLabel(v) {
  if (DATA.metric === 'tokens') return tok(v);
  if (v >= 10000) return '$' + Math.round(v / 1000) + 'K';
  if (v >= 1) return '$' + (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2));
  return '$' + v.toFixed(2);
}

// ---------- tooltip ----------
const tip = $('tip');
function showTip(html, ev) {
  tip.innerHTML = html;
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14; let y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}
const hideTip = () => { tip.style.display = 'none'; };

function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}
/** Column with a 4px rounded data end and a square baseline. */
function colPath(x, y, w, h) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// ---------- status ----------
const STATUS = {
  ok: { color: 'var(--good)', label: 'On pace', icon: '<circle cx="7" cy="7" r="5" fill="currentColor"/>' },
  idle: { color: 'var(--muted)', label: 'Idle', icon: '<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
  watch: { color: 'var(--warning)', label: 'Watch', icon: '<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/>' },
  warn: { color: 'var(--serious)', label: 'Burning fast', icon: '<path d="M7 1.5 13 12H1Z" fill="currentColor"/>' },
  critical: { color: 'var(--critical)', label: 'Will hit limit', icon: '<path d="M7 1.5 13 12H1Z" fill="currentColor"/><rect x="6.2" y="5" width="1.6" height="3.6" fill="var(--surface)"/><rect x="6.2" y="9.4" width="1.6" height="1.6" fill="var(--surface)"/>' },
};
function statusHtml(s, label) {
  const st = STATUS[s] || STATUS.ok;
  if (label) return `<span class="status"><svg viewBox="0 0 14 14" style="color:${st.color}" aria-hidden="true">${st.icon}</svg>${label}</span>`;
  return `<span class="status"><svg viewBox="0 0 14 14" style="color:${st.color}" aria-hidden="true">${st.icon}</svg>${st.label}</span>`;
}
const SOURCE = { official: 'plan meter', calibrated: 'learned limit', configured: 'your config', history: 'vs. your history', derived: 'estimated' };

// ---------- sections ----------
function renderCycles() {
  const now = DATA.generatedAt;
  $('cycles').innerHTML = DATA.cycles.map((c) => {
    const used = c.used;
    const fill = used === undefined ? 0 : Math.min(1, used);
    const color = c.status === 'critical' ? 'var(--critical)' : c.status === 'warn' ? 'var(--serious)' : c.status === 'watch' ? 'var(--warning)' : 'var(--s1)';
    const rolling = c.label.indexOf('rolling') >= 0;
    const facts = [];
    if (c.pace !== undefined && c.pace !== null) facts.push(['Pace', `${c.pace.toFixed(2)}× <span style="color:var(--muted)">(used ÷ elapsed)</span>`]);
    if (!rolling && c.end > now) facts.push(['Resets', `${fmtTime(c.end)} · in ${dur(c.end - now)}`]);
    if ((c.pHit === undefined || c.pHit === null) && c.projected !== undefined && c.projected !== null) facts.push(['Projected at reset', pct(c.projected)]);
    if (c.etaFull && c.etaFull < c.end) facts.push(['Likely limit', `<b>${fmtTime(c.etaFull)}</b> · ${dur(c.end - c.etaFull)} early`]);
    facts.push(['Burn now', money(c.burnPerHour) + '/h']);
    if (c.safeBurnPerHour !== undefined && c.safeBurnPerHour !== null) facts.push(['Sustainable', '≤ ' + money(c.safeBurnPerHour) + '/h']);
    facts.push(['Used (API-equiv.)', money(c.usedCost) + (c.limitCost ? ' of ≈' + money(c.limitCost) : '')]);
    return `<article class="card">
      <div class="row"><h2>${esc(c.label)}</h2>${statusHtml(c.status, c.status === 'critical' && c.pHit !== undefined && c.pHit !== null && c.pHit < 0.5 ? 'Near limit' : undefined)}</div>
      <div class="row" style="margin-top:6px"><div class="big">${pct(used)}</div><span class="chip">${SOURCE[c.source]}</span></div>
      <div class="label">${rolling ? 'of your heaviest week' : `used · ${pct(c.elapsed)} of the cycle has passed`}</div>
      <div class="meter" role="img" aria-label="${pct(used)} used, ${pct(c.elapsed)} of cycle elapsed">
        <i style="width:${fill * 100}%;background:${color}"></i>${rolling ? '' : `<b style="left:calc(${c.elapsed * 100}% - 1px)" title="Even pace"></b>`}
      </div>
      <div class="meter-legend"><span>0%</span>${rolling ? '' : `<span>▏ even pace = ${pct(c.elapsed)}</span>`}<span>100%</span></div>
      ${riskHtml(c)}${burnSvg(c)}
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${(c.notes || []).map((n) => `<div class="note">ⓘ ${esc(n)}</div>`).join('')}
    </article>`;
  }).join('') + (DATA.official.available ? '' : `<article class="card"><h2>Plan meter</h2><p class="sub">Unavailable: ${esc(DATA.official.reason || 'unknown')}.</p><p class="note">ccpulse falls back to limits it learned earlier, your config, or your own history. Learned limits: ${DATA.calibration.filter((c) => isFinite(c.limitCost)).map((c) => esc(c.key) + ' ≈ ' + money(c.limitCost)).join(', ') || 'none yet'}.</p></article>`);
}

function deltaHtml(now, prev) {
  if (!prev) return '';
  const d = (now - prev) / prev;
  const s = (d >= 0 ? '+' : '') + Math.round(d * 100) + '%';
  return `<span class="delta" style="color:var(--ink-2)">${d >= 0 ? '▲' : '▼'} ${s} vs. last time (${val(prev)})</span>`;
}
function renderTiles() {
  const f = DATA.forecast;
  const spark = (series) => {
    const vals = series.map(mval); const max = Math.max(...vals, 0) || 1;
    const w = 120; const h = 28; const bw = w / vals.length;
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${vals.map((v, i) => {
      const bh = Math.max(v > 0 ? 1 : 0, (v / max) * h);
      return `<rect x="${i * bw + 0.5}" y="${h - bh}" width="${Math.max(1, bw - 1)}" height="${bh}" rx="1" fill="${i === vals.length - 1 ? 'var(--s1)' : 'var(--axis)'}"/>`;
    }).join('')}</svg>`;
  };
  const tiles = [
    [f.today, DATA.series.hour.slice(-24)],
    [f.week, DATA.series.day.slice(-14)],
    [f.month, DATA.series.month.slice(-12)],
  ];
  $('tiles').innerHTML = tiles.map(([p, s]) => `<article class="card">
      <div class="row"><span class="label">${esc(p.label)} · so far</span>${spark(s)}</div>
      <div class="big">${val(p.actualSoFar)}</div>
      <div class="label" style="margin-top:4px">Forecast <b style="color:var(--ink)">${val(p.value)}</b> · 80% range ${val(p.lo)}–${val(p.hi)}</div>
      ${deltaHtml(p.value, p.previous)}
    </article>`).join('');
}

function renderTrend() {
  for (const b of document.querySelectorAll('[data-g]')) b.setAttribute('aria-pressed', String(b.dataset.g === gran));
  const series = DATA.series[gran];
  const W = Math.max(300, Math.round($('trend').clientWidth || 1000)); const H = W < 600 ? 220 : 300; const L = 52; const R = 8; const T = 12; const B = 30;
  const forecast = gran === 'day' ? DATA.forecast.next7 : [];
  const normal = gran === 'hour' ? DATA.hourExpected : null;
  const n = series.length + forecast.length;
  const values = series.map(mval);
  const scale = niceScale(Math.max(...values, ...(normal || []), ...forecast.map((p) => p.hi * 0.8), 0));
  const max = scale.top;
  const band = (W - L - R) / n;
  const bw = Math.min(24, Math.max(2, band - 2));
  const y = (v) => T + (H - T - B) * (1 - Math.min(v, max) / max);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Usage trend' });
  for (let i = 0; i * scale.step <= max + 1e-9; i++) {
    const v = scale.step * i; const yy = y(v);
    el('line', { x1: L, x2: W - R, y1: yy, y2: yy, stroke: i === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg);
    const t = el('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, svg);
    t.textContent = tickLabel(v);
  }
  const every = Math.ceil(n / Math.max(3, Math.floor(W / 95)));
  const xLabel = (b, i) => {
    const d = new Date(b.start);
    const o = { timeZone: DATA.timezone };
    if (gran === 'hour') return d.toLocaleTimeString([], { ...o, hour: '2-digit' }) + (i === 0 || d.toLocaleTimeString('en-US', { ...o, hour: 'numeric', hourCycle: 'h23' }) === '0' ? ' ' + d.toLocaleDateString([], { ...o, weekday: 'short' }) : '');
    if (gran === 'month') return d.toLocaleDateString([], { ...o, month: 'short', year: '2-digit' });
    return d.toLocaleDateString([], { ...o, month: 'short', day: 'numeric' });
  };
  const all = series.map((b) => ({ kind: 'actual', b })).concat(forecast.map((p) => ({ kind: 'forecast', p })));
  all.forEach((item, i) => {
    const cx = L + band * i + band / 2;
    const x = cx - bw / 2;
    const g = el('g', {}, svg);
    if (item.kind === 'actual') {
      const v = mval(item.b);
      el('path', { d: colPath(x, y(v), bw, y(0) - y(v)), fill: 'var(--s1)' }, g);
    } else {
      const p = item.p;
      el('path', { d: colPath(x, y(p.value), bw, y(0) - y(p.value)), fill: 'var(--s1-soft)' }, g);
      el('line', { x1: cx, x2: cx, y1: y(p.lo), y2: y(Math.min(p.hi, max)), stroke: 'var(--ink-2)', 'stroke-width': 1 }, g);
      el('line', { x1: cx - 4, x2: cx + 4, y1: y(Math.min(p.hi, max)), y2: y(Math.min(p.hi, max)), stroke: 'var(--ink-2)', 'stroke-width': 1 }, g);
      el('line', { x1: cx - 4, x2: cx + 4, y1: y(p.lo), y2: y(p.lo), stroke: 'var(--ink-2)', 'stroke-width': 1 }, g);
    }
    if (i % every === 0) {
      const t = el('text', { x: cx, y: H - 10, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, svg);
      t.textContent = item.kind === 'actual' ? xLabel(item.b, i) : xLabel(item.p, i);
    }
    // Hit target spans the full band and the full height.
    const hit = el('rect', { x: L + band * i, y: T, width: band, height: H - T - B, fill: 'transparent' }, g);
    hit.addEventListener('mousemove', (ev) => {
      let html;
      if (item.kind === 'actual') {
        const b = item.b; const prev = i > 0 ? series[i - 1] : null;
        html = `<b>${esc(b.label)}</b><br>${val(mval(b))}${DATA.metric === 'cost' ? ' · ' + tok(b.tokens) + ' tokens' : ' · ' + money(b.cost)}<br>${b.requests.toLocaleString()} requests`;
        if (normal) html += `<br><span style="color:var(--ink-2)">Your normal: ${val(normal[i])}</span>`;
        if (prev && mval(prev) > 0) html += `<br><span style="color:var(--ink-2)">vs. previous: ${((mval(b) / mval(prev) - 1) * 100).toFixed(0)}%</span>`;
      } else {
        const p = item.p;
        html = `<b>${esc(p.label)}</b> · forecast<br>${val(p.value)}<br><span style="color:var(--ink-2)">80% range ${val(p.lo)}–${val(p.hi)}</span>`;
      }
      showTip(html, ev);
      g.style.opacity = '0.85';
    });
    hit.addEventListener('mouseleave', () => { hideTip(); g.style.opacity = '1'; });
  });
  if (normal) {
    const pts = normal.map((v, i) => `${L + band * i + band / 2},${y(v)}`).join(' ');
    el('polyline', { points: pts, fill: 'none', stroke: 'var(--ink-2)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'pointer-events': 'none' }, svg);
  }
  if (gran === 'day' && DATA.changePoint) {
    const idx = series.findIndex((b) => b.start >= DATA.changePoint.at);
    if (idx > 0) {
      const cx = L + band * idx;
      el('line', { x1: cx, x2: cx, y1: T, y2: H - B, stroke: 'var(--ink-2)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }, svg);
      const t = el('text', { x: cx + 6, y: T + 12, 'font-size': 11, fill: 'var(--ink-2)' }, svg);
      t.textContent = `regime change ${DATA.changePoint.change >= 0 ? '+' : ''}${Math.round(DATA.changePoint.change * 100)}%`;
    }
  }
  $('trend').replaceChildren(svg);
  const legend = [`<span><i class="key" style="background:var(--s1)"></i>Actual</span>`];
  if (normal) legend.push(`<span><i class="key line" style="background:var(--ink-2)"></i>Your normal for that hour (learned)</span>`);
  if (forecast.length) legend.push(`<span><i class="key" style="background:var(--s1-soft)"></i>Forecast, with 80% range</span>`);
  $('trend-legend').innerHTML = legend.join('');
  const unit = DATA.metric === 'cost' ? 'API-equivalent USD' : 'tokens';
  $('trend-sub').textContent = { hour: 'Last 48 hours vs. your learned hour-of-week profile', day: 'Last 90 days plus a 7-day forecast', week: 'Last 26 weeks', month: 'Last 12 months' }[gran] + ' · ' + unit;
  $('trend-table').innerHTML = `<table><thead><tr><th>Period</th><th class="n">Requests</th><th class="n">Tokens</th><th class="n">Cost</th>${normal ? '<th class="n">Normal</th>' : ''}</tr></thead><tbody>${series.slice().reverse().map((b, j) => `<tr><td>${esc(b.label)}</td><td class="n">${b.requests.toLocaleString()}</td><td class="n">${tok(b.tokens)}</td><td class="n">${money(b.cost)}</td>${normal ? `<td class="n">${val(normal[series.length - 1 - j])}</td>` : ''}</tr>`).join('')}</tbody></table>`;
}

function renderHeatmap() {
  const hm = DATA.habits.heatmap;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const sunday = DATA.weekStart === 'sunday';
  const names = sunday ? ['Sun'].concat(days.slice(0, 6)) : days;
  const flat = hm.flat().filter((v) => v > 0).sort((a, b) => a - b);
  // Quantile steps so one extreme hour does not wash out the rest.
  const qs = [0.15, 0.3, 0.45, 0.6, 0.75, 0.88, 0.96].map((q) => flat[Math.floor(q * (flat.length - 1))] || 0);
  const step = (v) => (v <= 0 ? 0 : 1 + qs.filter((q) => v > q).length);
  const cw = 22; const ch = 20; const gap = 2; const L = 34; const T = 4;
  const W = L + 24 * cw; const H = T + 7 * ch + 22;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Average usage by weekday and hour' });
  for (let w = 0; w < 7; w++) {
    const t = el('text', { x: L - 6, y: T + w * ch + ch / 2 + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--muted)' }, svg);
    t.textContent = names[w];
    for (let h = 0; h < 24; h++) {
      const v = hm[w][h];
      const r = el('rect', { x: L + h * cw + gap / 2, y: T + w * ch + gap / 2, width: cw - gap, height: ch - gap, rx: 3, fill: `var(--seq-${Math.min(7, step(v))})` }, svg);
      r.addEventListener('mousemove', (ev) => showTip(`<b>${names[w]} ${String(h).padStart(2, '0')}:00</b><br>avg ${val(v)} per hour`, ev));
      r.addEventListener('mouseleave', hideTip);
    }
  }
  for (const h of [0, 6, 12, 18, 23]) {
    const t = el('text', { x: L + h * cw + cw / 2, y: H - 6, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--muted)' }, svg);
    t.textContent = String(h).padStart(2, '0');
  }
  $('heatmap').replaceChildren(svg);
}

const KIND_ICON = { warning: '⚠', tip: '➜', trend: '↗', pattern: '•', efficiency: '◎' };
function renderInsights() {
  $('insights').innerHTML = DATA.insights.length
    ? DATA.insights.map((i) => `<div class="insight"><span aria-hidden="true" style="color:${i.kind === 'warning' ? 'var(--critical)' : 'var(--ink-2)'}">${KIND_ICON[i.kind] || '•'}</span><span class="t">${esc(i.title)}</span><span class="d">${esc(i.detail)}</span></div>`).join('')
    : '<div class="empty">Not enough history yet.</div>';
}

function renderAnomalies() {
  const a = DATA.anomalies.slice(0, 14);
  if (!a.length) return void ($('anomalies').innerHTML = '<div class="empty">Nothing unusual in the last 7 days.</div>');
  const sev = { extreme: ['var(--critical)', 'Extreme'], high: ['var(--serious)', 'High'], notice: ['var(--warning)', 'Notice'] };
  $('anomalies').innerHTML = `<table><thead><tr><th>Severity</th><th>When</th><th class="n">Value</th><th class="n">× busy</th></tr></thead><tbody>${a.map((x) => `<tr title="${esc(x.explanation)}">
      <td><span class="status"><svg viewBox="0 0 14 14" style="color:${sev[x.severity][0]}" aria-hidden="true"><path d="M7 1.5 13 12H1Z" fill="currentColor"/></svg>${sev[x.severity][1]}</span></td>
      <td>${esc(x.kind)} · ${esc(x.label)}<div style="color:var(--muted);font-size:11px">${esc(x.explanation)}</div></td>
      <td class="n">${val(x.value)}</td><td class="n">${isFinite(x.ratio) ? x.ratio.toFixed(1) + '×' : '∞'}</td></tr>`).join('')}</tbody></table>`;
}

function renderNext7() {
  const f = DATA.forecast;
  $('fc-sub').textContent = `${f.model}. Backtest: ${isFinite(f.accuracy.wape) ? Math.round(f.accuracy.wape * 100) + '% avg. daily error, ' + Math.round(f.accuracy.coverage * 100) + '% of days inside the range' : 'not enough history yet'}. Trend ${(f.weeklyTrend.slopePct * 100).toFixed(1)}%/week (R² ${f.weeklyTrend.r2.toFixed(2)}).`;
  const max = Math.max(...f.next7.map((p) => p.value), 0) || 1;
  $('next7').innerHTML = `<table><thead><tr><th>Day</th><th class="n">Forecast</th><th class="n">80% range</th><th class="bar-cell"></th></tr></thead><tbody>${f.next7.map((p) => `<tr><td>${esc(p.label)}</td><td class="n">${val(p.value)}</td><td class="n" style="color:var(--ink-2)">${val(p.lo)}–${val(p.hi)}</td><td class="bar-cell"><div class="hbar" style="width:${(p.value / max) * 100}%;background:var(--s1-soft)"></div></td></tr>`).join('')}
    <tr><td><b>${esc(f.nextMonth.label)}</b></td><td class="n"><b>${val(f.nextMonth.value)}</b></td><td class="n" style="color:var(--ink-2)">${val(f.nextMonth.lo)}–${val(f.nextMonth.hi)}</td><td></td></tr></tbody></table>`;
}

function rankTable(rows, key) {
  const total = rows.reduce((a, r) => a + mval(r.totals), 0) || 1;
  const max = Math.max(...rows.map((r) => mval(r.totals)), 0) || 1;
  return `<table><thead><tr><th>${key === 'model' ? 'Model' : 'Project'}</th><th class="n">Requests</th><th class="n">${DATA.metric === 'cost' ? 'Cost' : 'Tokens'}</th><th class="n">Share</th><th class="bar-cell"></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r[key])}</td><td class="n">${r.totals.requests.toLocaleString()}</td><td class="n">${val(mval(r.totals))}</td><td class="n">${pct(mval(r.totals) / total)}</td><td class="bar-cell"><div class="hbar" style="width:${(mval(r.totals) / max) * 100}%"></div></td></tr>`).join('')}</tbody></table>`;
}

function render() {
  $('error').innerHTML = '';
  $('updated').textContent = 'Updated ' + new Date(DATA.generatedAt).toLocaleTimeString([], { timeZone: DATA.timezone, hour: '2-digit', minute: '2-digit' }) + ' · ' + DATA.timezone + ' · ' + DATA.entries.toLocaleString() + ' requests';
  $('subtitle').textContent = DATA.firstSeen ? 'since ' + fmtDate(DATA.firstSeen) : 'Claude Code usage';
  renderPlanBar(); renderCycles(); renderTiles(); renderTrend(); renderHeatmap(); renderInsights(); renderAnomalies(); renderNext7();
  renderAnatomy(); renderContext(); renderMix(); renderSessions(); renderBreakdowns(); renderApi();
  $('models').innerHTML = rankTable(DATA.models.slice(0, 10), 'model');
  $('projects').innerHTML = rankTable(DATA.projects.slice(0, 12), 'project');
  if (DATA.warnings.length) $('footer').textContent += ' ' + DATA.warnings.join(' ');
}

async function load() {
  try {
    const r = await fetch('/api/analysis', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    DATA = await r.json();
    render();
  } catch (e) {
    $('error').innerHTML = `<div class="err">Could not load data: ${esc(e.message)}. Is <code>ccpulse dashboard</code> still running?</div>`;
  }
}

for (const b of document.querySelectorAll('[data-g]')) b.addEventListener('click', () => {
  gran = b.dataset.g;
  try { localStorage.setItem('ccpulse.gran', gran); } catch (_) { /* ignore */ }
  if (DATA) renderTrend();
});
$('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('ccpulse.theme', root.dataset.theme); } catch (_) { /* ignore */ }
});
try { const t = params.get('theme') || localStorage.getItem('ccpulse.theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (_) { /* ignore */ }

// ---------- plan bar ----------
function renderPlanBar() {
  const p = DATA.plan; const v = DATA.planValue; const adv = DATA.planAdvice;
  const items = [];
  items.push(`<div class="item"><div class="label">Plan</div><div class="v">${esc(p.label)}</div><div class="label">${p.multiplier ? p.multiplier + '× Pro weekly · ' : ''}${p.noSessionLimit ? 'no 5-hour limit · ' : ''}${p.extraUsage ? 'extra usage on' : 'extra usage off'}</div></div>`);
  if (v.period) items.push(`<div class="item grow"><div class="label">Billing cycle · day ${v.period.day} of ${v.period.days} · renews ${fmtDate(v.period.end)}</div><div class="meter" style="margin:8px 0 2px"><i style="width:${Math.min(100, v.period.elapsed * 100)}%;background:var(--s1)"></i></div></div>`);
  items.push(`<div class="item"><div class="label">Value this cycle (API-equiv.)</div><div class="v">${money(v.valueSoFar)}${v.price ? ` <span class="label">= ${(v.valueSoFar / v.price).toFixed(1)}× the price</span>` : ''}</div><div class="label">projected ${money(v.valueProjected)}${v.price ? ` · price ${money(v.price)}/mo` : ''}</div></div>`);
  const icon = adv.verdict === 'upgrade' ? STATUS.critical : adv.verdict === 'downgrade' ? STATUS.ok : adv.verdict === 'fits' ? STATUS.ok : STATUS.watch;
  items.push(`<div class="item grow"><div class="label">Plan advice</div><div style="display:flex;gap:6px;align-items:center;font-weight:600"><svg viewBox="0 0 14 14" width="14" height="14" style="color:${icon.color};flex:none" aria-hidden="true">${icon.icon}</svg>${esc(adv.title)}</div><div class="label">${esc(adv.detail)}</div></div>`);
  $('planbar').innerHTML = items.join('');
}

// ---------- burn-down fan inside a cycle card ----------
function burnSvg(c) {
  const bd = (DATA.burndowns || []).find((b) => b.key === c.key);
  const risk = (DATA.risks || []).find((r) => r.key === c.key);
  if (!bd) return '';
  const W = 300; const H = 92; const L = 2; const R = 2; const T = 6; const B = 4;
  const maxV = Math.max(1.05, ...(risk ? risk.fan.map((f) => f.p90) : []), ...bd.actual.map((a) => a.v));
  const x = (t) => L + (W - L - R) * ((t - bd.start) / (bd.end - bd.start));
  const y = (v) => T + (H - T - B) * (1 - Math.min(v, maxV) / maxV);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Burn-down: cumulative usage vs. even pace and projection">`;
  svg += `<line x1="${L}" x2="${W - R}" y1="${y(1)}" y2="${y(1)}" stroke="var(--critical)" stroke-width="1" opacity=".6"/>`;
  svg += `<line x1="${x(bd.start)}" y1="${y(0)}" x2="${x(bd.end)}" y2="${y(1)}" stroke="var(--axis)" stroke-width="1.5"/>`;
  if (risk && risk.fan.length) {
    const last = bd.actual[bd.actual.length - 1];
    const up = [{ t: last.t, v: last.v }].concat(risk.fan.map((f) => ({ t: f.t, v: f.p90 })));
    const lo = [{ t: last.t, v: last.v }].concat(risk.fan.map((f) => ({ t: f.t, v: f.p10 })));
    svg += `<path d="M${up.map((p) => `${x(p.t)},${y(p.v)}`).join('L')}L${lo.reverse().map((p) => `${x(p.t)},${y(p.v)}`).join('L')}Z" fill="var(--s1)" opacity=".14"/>`;
    svg += `<polyline points="${[{ t: last.t, v: last.v }].concat(risk.fan.map((f) => ({ t: f.t, v: f.p50 }))).map((p) => `${x(p.t)},${y(p.v)}`).join(' ')}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-dasharray="1 4" stroke-linecap="round"/>`;
  }
  svg += `<polyline points="${bd.actual.map((p) => `${x(p.t)},${y(p.v)}`).join(' ')}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  svg += '</svg>';
  return `<div class="mini" title="Solid: used so far · diagonal: even pace · dotted + band: simulated median and 10–90% range · red: limit">${svg}</div>`;
}

function riskHtml(c) {
  if (c.pHit === undefined || c.pHit === null) return '';
  const col = c.pHit >= 0.5 ? 'var(--critical)' : c.pHit >= 0.2 ? 'var(--serious)' : 'var(--good-text)';
  return `<div class="risk"><b style="color:${col}">${pct(c.pHit)}</b><span class="label">chance of hitting the limit before reset · median at reset ${pct(c.projected)}</span></div>`;
}

// ---------- cost anatomy ----------
function renderAnatomy() {
  const an = DATA.advanced.anatomy;
  const parts = [
    ['Cache writes (1h)', an.cacheWrite1h, 'var(--c1)'],
    ['Cache reads', an.cacheRead, 'var(--c2)'],
    ['Output', an.output, 'var(--c3)'],
    ['Cache writes (5m)', an.cacheWrite5m, 'var(--c4)'],
    ['Uncached input', an.input, 'var(--c-other)'],
  ].sort((a, b) => b[1] - a[1]);
  const t = an.total || 1;
  $('anat-sub').textContent = `${money(an.total)} over 30 days. Without prompt caching: ~${money(an.withoutCache)} (${(an.withoutCache / t).toFixed(1)}×). Thinking is ${money(an.thinking)} of output.`;
  $('anatomy').innerHTML = `<div class="stack" role="img" aria-label="Cost by token type">${parts.map(([k, v, col]) => `<i style="width:${(v / t) * 100}%;background:${col}" title="${k}: ${money(v)}"></i>`).join('')}</div>
    <table><thead><tr><th>Token type</th><th class="n">Cost</th><th class="n">Share</th></tr></thead><tbody>${parts.map(([k, v, col]) => `<tr><td><i class="key" style="background:${col};margin-right:8px;vertical-align:-1px"></i>${k}</td><td class="n">${money(v)}</td><td class="n">${pct(v / t)}</td></tr>`).join('')}</tbody></table>
    <div style="margin-top:12px">${DATA.advanced.anatomy.byModel.slice(0, 5).map((m) => `<div class="budget" style="grid-template-columns:150px 1fr auto"><span>${esc(m.model)}</span><div class="hbar" style="width:${(m.total / (DATA.advanced.anatomy.byModel[0].total || 1)) * 100}%"></div><span class="n">${money(m.total)}</span></div>`).join('')}</div>`;
}

function renderContext() {
  const c = DATA.advanced.context;
  const st = (k, v, s) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  $('context').innerHTML = [
    st('Prompt per request', tok(c.promptP50), `p90 ${tok(c.promptP90)} · p99 ${tok(c.promptP99)}`),
    st('Requests over 200k', pct(c.over200kShare), `${pct(c.over200kCostShare)} of cost`),
    st('Context growth', `+${tok(c.growthPerTurn)}`, 'tokens per turn in a session'),
    st('Cache hit rate', pct(c.cacheHitRate), `each cached token re-read ${c.cacheReuse.toFixed(0)}×`),
    st('Re-read above 100k', money(c.heavyContextCost), '/compact or /clear could save this'),
    st('Thinking', pct(c.thinkingShareOfOutput), 'of output tokens'),
  ].join('');
}

// ---------- model mix (stacked columns, fixed categorical order) ----------
function renderMix() {
  const mix = DATA.advanced.mix;
  if (!mix.points.length) return void ($('mix').innerHTML = '<div class="empty">Not enough history yet.</div>');
  const cols = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c-other)'];
  const colorOf = (m, i) => (m === 'other' ? 'var(--c-other)' : cols[i]);
  $('mix-legend').innerHTML = mix.models.map((m, i) => `<span><i class="key" style="background:${colorOf(m, i)}"></i>${esc(m.replace('claude-', ''))}</span>`).join('');
  const W = Math.max(300, Math.round($('mix').clientWidth || 1000)); const H = 200; const L = 40; const B = 26; const T = 6;
  const n = mix.points.length; const band = (W - L - 4) / n; const bw = Math.min(40, band - 6);
  const y = (v) => T + (H - T - B) * (1 - v);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Weekly model mix' });
  for (const v of [0, 0.5, 1]) {
    el('line', { x1: L, x2: W - 4, y1: y(v), y2: y(v), stroke: v === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg);
    const t = el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, svg); t.textContent = pct(v);
  }
  mix.points.forEach((p, i) => {
    const x = L + band * i + (band - bw) / 2;
    let acc = 0;
    const g = el('g', {}, svg);
    mix.models.forEach((m, k) => {
      const v = p.shares[m] || 0; if (v <= 0) return;
      const y0 = y(acc); const y1 = y(acc + v);
      el('rect', { x, y: y1 + 1, width: bw, height: Math.max(0, y0 - y1 - 2), fill: colorOf(m, k), rx: 2 }, g);
      acc += v;
    });
    const hit = el('rect', { x: L + band * i, y: T, width: band, height: H - T - B, fill: 'transparent' }, g);
    hit.addEventListener('mousemove', (ev) => showTip(`<b>${esc(p.label)}</b><br>${mix.models.filter((m) => p.shares[m]).map((m) => `${esc(m.replace('claude-', ''))}: ${pct(p.shares[m])}`).join('<br>')}<br><span style="color:var(--ink-2)">total ${val(p.total)}</span>`, ev));
    hit.addEventListener('mouseleave', hideTip);
    if (i % Math.ceil(n / 8) === 0) { const t = el('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, svg); t.textContent = fmtDate(p.start); }
  });
  $('mix').replaceChildren(svg);
}

function renderSessions() {
  const s = DATA.advanced.sessions;
  $('ses-sub').textContent = `${s.count.toLocaleString()} working sessions (split at 2 h idle) · median ${dur(s.durationP50)}, ${money(s.costP50)} · p90 ${money(s.costP90)} · ${s.oneShot.toLocaleString()} one-shot automations carry ${pct(s.oneShotCostShare)} of cost.`;
  $('sessions').innerHTML = `<table><thead><tr><th>Project</th><th>Model</th><th>Started</th><th class="n">Length</th><th class="n">Req.</th><th class="n">Cost</th></tr></thead><tbody>${s.top.slice(0, 6).map((t) => `<tr><td>${esc(t.project)}</td><td>${esc(t.model.replace('claude-', ''))}</td><td>${fmtTime(t.start)}</td><td class="n">${dur(t.end - t.start)}</td><td class="n">${t.requests.toLocaleString()}</td><td class="n">${money(t.cost)}</td></tr>`).join('')}</tbody></table>`;
}

function renderBreakdowns() {
  const block = (title, rows) => rows.length ? `<div style="margin-bottom:12px"><div class="label" style="margin-bottom:4px">${title}</div>${rows.slice(0, 4).map((b) => `<div class="budget" style="grid-template-columns:110px 1fr 120px"><span>${esc(b.key)}</span><div class="hbar" style="width:${Math.max(1, b.share * 100)}%"></div><span class="n" style="text-align:right">${pct(b.share)} · ${money(b.costPerRequest)}/req</span></div>`).join('')}</div>` : '';
  const a = DATA.advanced;
  $('breakdowns').innerHTML = block('Effort level', a.byEffort) + block('Main thread vs. subagents', a.bySubagent) + block('Entry point', a.byEntrypoint) +
    `<div class="label">Concentration: top project ${pct(a.concentration.topShare)}, top 3 ${pct(a.concentration.top3Share)} (≈ ${a.concentration.effectiveProjects.toFixed(1)} equal-sized projects)</div>`;
}

// ---------- API ----------
function renderApi() {
  const r = DATA.api;
  $('api-section').classList.toggle('hidden', !r);
  if (!r) return;
  const m = r.month;
  $('api-heading').textContent = `API spend · ${r.organization.name}`;
  const tile = (k, v, s) => `<article class="card"><div class="label">${k}</div><div class="big">${v}</div><div class="label">${s}</div></article>`;
  const vs = m.lastMonthToDate ? `${m.spend >= m.lastMonthToDate ? '▲' : '▼'} ${Math.round(Math.abs(m.spend / m.lastMonthToDate - 1) * 100)}% vs. same point last month` : '';
  $('api-tiles').innerHTML = [
    tile('This month so far', money(m.spend), `${pct(m.elapsed)} of the month · ${vs}`),
    tile('Month-end forecast', money(m.projected), `80% range ${money(m.lo)}–${money(m.hi)}`),
    tile('Last month', money(m.lastMonth), m.listSpend > m.spend ? `discounts saved ${money(m.listSpend - m.spend)} this month` : ''),
    tile('Forecast accuracy', `${Math.round(r.forecast.wape * 100)}%`, `avg. daily error · ${Math.round(r.forecast.coverage * 100)}% of days in range`),
  ].join('');
  // daily chart with forecast
  const series = r.daily.slice(-45); const fc = r.next7;
  const W = Math.max(300, Math.round($('api-chart').clientWidth || 600)); const H = 210; const L = 48; const T = 8; const B = 26;
  const n = series.length + fc.length; const band = (W - L - 4) / n; const bw = Math.min(16, Math.max(2, band - 2));
  const sc = niceScale(Math.max(...series.map((d) => d.usd), ...fc.map((p) => p.hi), 1)); const max = sc.top;
  const y = (v) => T + (H - T - B) * (1 - Math.min(v, max) / max);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Daily API spend with forecast' });
  for (let i = 0; i * sc.step <= max + 1e-9; i++) { const v = i * sc.step; el('line', { x1: L, x2: W - 4, y1: y(v), y2: y(v), stroke: i ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1 }, svg); const t = el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, svg); t.textContent = '$' + (v >= 1000 ? (v / 1000) + 'K' : v); }
  const items = series.map((d) => ({ t: d.t, v: d.usd, f: false })).concat(fc.map((p) => ({ t: p.t, v: p.usd, lo: p.lo, hi: p.hi, f: true })));
  items.forEach((it, i) => {
    const cx = L + band * i + band / 2; const g = el('g', {}, svg);
    el('path', { d: colPath(cx - bw / 2, y(it.v), bw, y(0) - y(it.v)), fill: it.f ? 'var(--s1-soft)' : 'var(--s1)' }, g);
    if (it.f) el('line', { x1: cx, x2: cx, y1: y(it.lo), y2: y(it.hi), stroke: 'var(--ink-2)', 'stroke-width': 1 }, g);
    const hit = el('rect', { x: L + band * i, y: T, width: band, height: H - T - B, fill: 'transparent' }, g);
    hit.addEventListener('mousemove', (ev) => showTip(`<b>${new Date(it.t).toISOString().slice(0, 10)}</b> (UTC)<br>${money(it.v)}${it.f ? ` forecast<br><span style="color:var(--ink-2)">80% ${money(it.lo)}–${money(it.hi)}</span>` : ''}`, ev));
    hit.addEventListener('mouseleave', hideTip);
    if (i % Math.ceil(n / 7) === 0) { const t = el('text', { x: cx, y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, svg); t.textContent = new Date(it.t).toLocaleDateString([], { timeZone: 'UTC', month: 'short', day: 'numeric' }); }
  });
  $('api-chart').replaceChildren(svg);
  $('api-chart-sub').textContent = `Last 45 days (UTC) and the next 7. Model α=${r.forecast.alpha}. ${r.notes[0] || ''}`;
  $('api-budgets').innerHTML = r.budgets.length ? r.budgets.map((b) => {
    const col = b.status === 'critical' ? 'var(--critical)' : b.status === 'warn' ? 'var(--serious)' : b.status === 'watch' ? 'var(--warning)' : 'var(--s1)';
    const st = { critical: 'critical', warn: 'warn', watch: 'watch', ok: 'ok' }[b.status];
    return `<div class="budget"><span><b>${esc(b.name)}</b><br><span class="label">${money(b.spend)} / ${money(b.monthly)}</span></span><div><div class="meter" style="margin:4px 0"><i style="width:${Math.min(100, b.used * 100)}%;background:${col}"></i><b style="left:calc(${b.elapsed * 100}% - 1px)"></b></div><span class="label">pace ${b.pace.toFixed(2)}× · projected ${money(b.projected)}</span></div>${statusHtml(st, { critical: 'Projected over', warn: 'Burning fast', watch: 'Watch', ok: 'On track' }[st])}</div>`;
  }).join('') : '<div class="empty">No budgets. Add <code>api.budgets</code> to your config.</div>';
  $('api-hygiene').innerHTML = r.hygiene.length ? r.hygiene.slice(0, 6).map((h) => `<div class="insight"><span aria-hidden="true" style="color:${h.level === 'warn' ? 'var(--serious)' : 'var(--ink-2)'}">${h.level === 'warn' ? '⚠' : '•'}</span><span class="t">${esc(h.title)}</span><span class="d">${esc(h.detail)}</span></div>`).join('') : '<div class="empty">Nothing to fix.</div>';
  const grp = (rows, extra) => `<table><thead><tr><th>Name</th><th class="n">This month</th><th class="n">Share</th><th class="n">7d vs prior</th>${extra ? '<th>Last used</th>' : ''}</tr></thead><tbody>${rows.slice(0, 8).map((g) => `<tr><td>${esc(g.name)}${g.status && g.status !== 'active' ? ` <span class="chip">${esc(g.status)}</span>` : ''}</td><td class="n">${money(g.monthToDate)}</td><td class="n">${pct(g.share)}</td><td class="n">${g.prev7 ? ((g.last7 / g.prev7 - 1) >= 0 ? '+' : '') + Math.round((g.last7 / g.prev7 - 1) * 100) + '%' : '–'}</td>${extra ? `<td>${g.lastUsed ? fmtDate(g.lastUsed) : '–'}</td>` : ''}</tr>`).join('')}</tbody></table>`;
  $('api-ws').innerHTML = grp(r.byWorkspace, false);
  $('api-keys').innerHTML = grp(r.byKey, true);
}

let rz;
addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (DATA) { renderTrend(); renderMix(); renderApi(); } }, 150); });
load();
setInterval(load, 60000);
