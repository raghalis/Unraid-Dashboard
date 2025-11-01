import { q, toast, buildShell } from './common.js';

function percent(v){
  if (v == null || isNaN(v)) return '—';
  return `${Math.round(Number(v))}%`;
}

function rowToHtml(s){
  const addr = s.baseUrl || '';
  const array = s?.status?.system?.array?.status || '—';
  const cpu = s?.status?.metrics?.cpuPct ?? s?.status?.cpuPct;
  const ram = s?.status?.metrics?.ramPct ?? s?.status?.ramPct;
  const sto = s?.status?.metrics?.storagePct ?? s?.status?.storagePct;
  const ok = s?.status ? 'OK' : '—';

  return `
    <tr>
      <td data-label="Name">${s.name || '—'}</td>
      <td data-label="Server Address"><a href="${addr}" target="_blank" rel="noreferrer">${addr}</a></td>
      <td data-label="Array">${array}</td>
      <td data-label="CPU%">${percent(cpu)}</td>
      <td data-label="RAM%">${percent(ram)}</td>
      <td data-label="Storage%">${percent(sto)}</td>
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
  }catch(e){
    toast('Failed to load servers','bad');
  }
}

async function schedule(){
  try{
    const r = await fetch('/api/app'); const j = await r.json();
    const sec = Math.max(5, Number(j?.settings?.refreshSeconds) || 30);
    setInterval(load, sec*1000);
  }catch{ setInterval(load, 30000); }
}

window.addEventListener('DOMContentLoaded', async ()=>{
  await buildShell('dash');
  await load();
  await schedule();
});