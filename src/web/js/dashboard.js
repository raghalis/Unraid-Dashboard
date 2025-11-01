import { q, el, fmtPct } from './common.js';

function safe(v, fallback='—'){ return (v===null || v===undefined || v!==v) ? fallback : v; }

async function load(){
  const r = await fetch('/api/servers');
  const arr = await r.json();
  const tbody = q('#servers-body'); if (!tbody) return;
  tbody.innerHTML = '';
  (Array.isArray(arr) ? arr : []).forEach(s=>{
    const sys = s?.status?.system || {};
    const cap = s?.status?.capacity || {};     // optional (may not exist)
    const cpu = s?.status?.cpu ?? null;
    const mem = s?.status?.mem ?? null;
    const ok = !!s?.status;                    // if we got *anything* back
    const tr = el('tr', {}, [
      el('td', {}, s.name || '—'),
      el('td', {}, el('a', {href:s.baseUrl, target:'_blank'}, s.baseUrl || '—')),
      el('td', {}, safe(sys.array?.status || sys.array?.state || '—')),
      el('td', {}, fmtPct(cpu)),
      el('td', {}, fmtPct(mem)),
      el('td', {}, cap.usedPct != null ? fmtPct(cap.usedPct) : '—'),
      el('td', {}, ok ? el('span', {class:'pill ok'}, 'OK') : el('span', {class:'pill bad'}, 'ERR'))
    ]);
    tbody.appendChild(tr);
  });
}
window.addEventListener('DOMContentLoaded', load);