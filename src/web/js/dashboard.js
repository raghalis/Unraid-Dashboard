import { q, toast, buildShell } from './common.js';

function pct(v){ if (v == null || isNaN(v)) return 0; return Math.max(0, Math.min(100, Math.round(Number(v)))); }
function meterHTML(label, value){
  const p = pct(value);
  return `<div class="meter" aria-label="${label}" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100">
            <div class="fill" style="width:${p}%"></div>
            <span class="val">${p}%</span>
          </div>`;
}

function rowToHtml(s){
  const addr = s.baseUrl || '';
  const array = (s?.status?.system?.array?.status) || '—';
  const cpu = s?.status?.metrics?.cpuPct ?? null;
  const ram = s?.status?.metrics?.ramPct ?? null;
  const sto = s?.status?.metrics?.storagePct ?? null;
  const ok = s?.status ? 'OK' : '—';

  return `
    <tr>
      <td data-label="Name">${s.name || '—'}</td>
      <td data-label="Server Address"><a href="${addr}" target="_blank" rel="noreferrer">${addr}</a></td>
      <td data-label="Array">${array}</td>
      <td data-label="CPU%"><div class="meter-wrap">${meterHTML('CPU', cpu)}</div></td>
      <td data-label="RAM%"><div class="meter-wrap">${meterHTML('RAM', ram)}</div></td>
      <td data-label="Storage%"><div class="meter-wrap">${meterHTML('Storage', sto)}</div></td>
      <td data-label="Status"><span class="pill ${s.status ? 'ok':'bad'}">${ok}</span></td>
    </tr>`;
}

async function load(){
  try{
    const r = await fetch('/api/servers');
    const arr = await r.json();
    const tbody = q('#servers-body');
    if (!Array.isArray(arr)) { tbody.innerHTML=''; return; }
    tbody.innerHTML = arr.map(rowToHtml).join('');
  }catch{ toast('Failed to load servers','bad'); }
}

async function schedule(){
  try{
    const r = await fetch('/api/app'); const j = await r.json();
    const sec = Math.max(1, Number(j?.settings?.refreshSeconds) || 2); // allow 1s, default 2s
    setInterval(load, sec*1000);
  }catch{ setInterval(load, 2000); }
}

window.addEventListener('DOMContentLoaded', async ()=>{
  await buildShell('dash');
  await load();
  await schedule();
});