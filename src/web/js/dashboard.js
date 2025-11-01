import { q, fmtPct, el } from './common.js';

const state = { refreshSeconds: 30, timer: null };

async function fetchSettings() {
  const r = await fetch('/api/app'); const j = await r.json();
  state.refreshSeconds = Math.max(5, j?.settings?.refreshSeconds ?? 30);
}

function gauge(value) {
  // Animated semicircle SVG gauge 0..100
  const pct = Math.max(0, Math.min(100, Number.isFinite(value)? value : 0));
  const dash = 157; // stroke length for semicircle
  const offs = dash - (dash * pct / 100);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox','0 0 200 120'); svg.classList.add('gauge');
  svg.innerHTML = `
    <path class="g-bg" d="M10,110 A90,90 0 0 1 190,110" />
    <path class="g-val" d="M10,110 A90,90 0 0 1 190,110"
          style="stroke-dasharray:${dash};stroke-dashoffset:${dash}" />
    <text x="100" y="105" text-anchor="middle" class="g-txt">${fmtPct(pct)}</text>`;
  requestAnimationFrame(()=>svg.querySelector('.g-val').style.strokeDashoffset = String(offs));
  return svg;
}

function statusPill(host) {
  const ok = !!host.status;
  const pill = el('span','pill ' + (ok?'ok':'bad'), ok ? 'OK' : 'ERR');
  if (host.warnings?.length) pill.classList.add('warn');
  return pill;
}

function row(host) {
  const cpu = host.status?.metrics?.cpuPct ?? null;
  const ram = host.status?.metrics?.ramPct ?? null;
  const sto = host.status?.metrics?.storagePct ?? null;

  const card = el('div','card');
  card.innerHTML = `
    <div class="row"><div>Name</div><div>${host.name}</div></div>
    <div class="row"><div>Array</div><div>${host.status?.system?.array?.status || '—'}</div></div>
    <div class="row gwrap"><div>CPU%</div><div class="gcell"></div></div>
    <div class="row gwrap"><div>RAM%</div><div class="gcell"></div></div>
    <div class="row gwrap"><div>Storage%</div><div class="gcell"></div></div>
    <div class="row"><div>Status</div><div class="pillwrap"></div></div>
  `;
  const g = card.querySelectorAll('.gcell');
  g[0].appendChild(gauge(cpu));
  g[1].appendChild(gauge(ram));
  g[2].appendChild(gauge(sto));
  card.querySelector('.pillwrap').appendChild(statusPill(host));
  return card;
}

async function load() {
  const r = await fetch('/api/servers');
  const data = await r.json();
  const wrap = q('#servers');
  wrap.innerHTML = '';
  data.forEach(h => wrap.appendChild(row(h)));
}

function schedule() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(load, state.refreshSeconds * 1000);
}

window.addEventListener('DOMContentLoaded', async () => {
  await fetchSettings();
  await load();
  schedule();
});