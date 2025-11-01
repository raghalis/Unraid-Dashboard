import { q, toast, buildShell } from './common.js';

const clampPct = v => (v==null||isNaN(v)) ? null : Math.max(0, Math.min(100, Math.round(Number(v))));

function meter(label, value){
  const p = clampPct(value);
  if (p == null) {
    return `<div class="meter u-muted" aria-label="${label}"><div class="track"></div><span class="val">—</span></div>`;
  }
  // color class by usage
  const cls = p >= 85 ? 'hot' : (p >= 60 ? 'warn' : 'ok');
  return `<div class="meter ${cls}" aria-label="${label}" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100">
    <div class="track"><div class="fill" style="width:${p}%"></div></div>
    <span class="val">${p}%</span>
  </div>`;
}

function statusPill(entry){
  // entry.status is {code,label} when online; otherwise entry.error exists
  if (!entry.status && entry.error) {
    return `<button class="pill offline" data-wake="${entry.baseUrl}">Offline</button>`;
  }
  const s = entry.status || { code:'unknown', label:'Unknown' };
  const cls =
    s.code === 'ok' ? 'ok' :
    s.code === 'parity' ? 'warn' :
    s.code === 'error' ? 'bad' :
    s.code === 'stopped' ? 'neutral' :
    'neutral';
  return `<span class="pill ${cls}">${s.label}</span>`;
}

function row(entry){
  const addr = entry.baseUrl || '';
  const cpu = entry?.status?.metrics?.cpuPct ?? entry?.metrics?.cpuPct;
  const ram = entry?.status?.metrics?.ramPct ?? entry?.metrics?.ramPct;
  const sto = entry?.status?.metrics?.storagePct ?? entry?.metrics?.storagePct;

  return `
    <tr>
      <td data-label="Name">${entry.name||'—'}</td>
      <td data-label="Server Address"><a href="${addr}" target="_blank" rel="noreferrer">${addr}</a></td>
      <td data-label="CPU%">${meter('CPU', cpu)}</td>
      <td data-label="RAM%">${meter('RAM', ram)}</td>
      <td data-label="Storage%">${meter('Storage', sto)}</td>
      <td data-label="Status">${statusPill(entry)}</td>
    </tr>`;
}

async function load(){
  try{
    const r = await fetch('/api/servers');
    const arr = await r.json();
    const tbody = q('#servers-body');
    tbody.innerHTML = Array.isArray(arr) ? arr.map(row).join('') : '';
    // wire WOL buttons
    tbody.querySelectorAll('[data-wake]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const base = btn.getAttribute('data-wake');
        try{
          const r = await fetch(`/api/host?action=power&base=${encodeURIComponent(base)}`, {
            method:'POST', headers:{'content-type':'application/json'},
            body: JSON.stringify({ action:'wake' })
          });
          const j = await r.json();
          j.ok ? toast('Wake packet sent','ok') : toast(j.message || 'Wake failed','bad');
        }catch{ toast('Wake failed','bad'); }
      });
    });
  }catch{
    toast('Failed to load servers','bad');
  }
}

async function schedule(){
  try{
    const r = await fetch('/api/app'); const j = await r.json();
    const sec = Math.max(1, Number(j?.settings?.refreshSeconds) || 2);
    setInterval(load, sec*1000);
  }catch{ setInterval(load, 2000); }
}

window.addEventListener('DOMContentLoaded', async ()=>{
  await buildShell('dash');
  await load();
  await schedule();
});