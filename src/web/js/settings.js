import { q, qa, val, setVal, toast, buildShell } from './common.js';

/* Simple local tab switcher (and buttons at the top) */
function initTabs(){
  const buttons = qa('[data-tab]');
  const panes = qa('.tabpane');
  const show = id => {
    panes.forEach(p=>p.classList.toggle('active', p.id === `tab-${id}`));
    // scroll to content top on mobile
    q(`#tab-${id}`)?.scrollIntoView({ behavior:'smooth', block:'start' });
  };
  buttons.forEach(b=>b.onclick = () => show(b.dataset.tab));
}

/* -------- Hosts table -------- */
async function refreshHosts(){
  const r = await fetch('/api/settings/hosts');
  const arr = await r.json();
  const tbody = q('#hosts-body'); tbody.innerHTML = '';
  (arr || []).forEach(h=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Name">${h.name}</td>
      <td data-label="Server Address">${h.baseUrl}</td>
      <td data-label="MAC">${h.mac}</td>
      <td data-label="Token">${h.tokenSet ? '<span class="pill ok">Validated</span>' : '<span class="pill bad">Not Set</span>'}</td>
      <td data-label="Actions" class="act">
        <button class="btn sm" data-act="edit">Edit</button>
        <button class="btn sm" data-act="test">Test</button>
        <button class="btn sm danger" data-act="del">Delete</button>
      </td>`;
    tr.querySelector('[data-act="test"]').onclick = async()=>{
      const r = await fetch(`/api/settings/test?base=${encodeURIComponent(h.baseUrl)}`);
      const j = await r.json();
      j.ok ? toast('Connection OK','ok') : toast(j.message || 'Test failed','bad');
      refreshHosts();
    };
    tr.querySelector('[data-act="del"]').onclick = async()=>{
      await fetch(`/api/settings/host?base=${encodeURIComponent(h.baseUrl)}`, { method:'DELETE' });
      toast('Deleted','ok'); refreshHosts();
    };
    tr.querySelector('[data-act="edit"]').onclick = ()=>{
      setVal('#name', h.name); setVal('#baseUrl', h.baseUrl);
      setVal('#mac', h.mac); setVal('#oldBaseUrl', h.baseUrl);
      q('#name').focus(); q('#tab-hosts').scrollIntoView({ behavior:'smooth', block:'start' });
    };
    tbody.appendChild(tr);
  });
}

/* -------- App settings load/save -------- */
async function loadAppSettings(){
  const r = await fetch('/api/app'); const j = await r.json();
  setVal('#refreshSeconds', j?.settings?.refreshSeconds ?? 30);
  setVal('#logLevel', j?.settings?.logLevel ?? 'info');
  q('#debugHttp').checked = !!j?.settings?.debugHttp;
  q('#allowSelfSigned').checked = !!j?.settings?.allowSelfSigned;
}
async function saveAppSettings(){
  const body = {
    refreshSeconds: Math.max(5, Number(val('#refreshSeconds')) || 30),
    logLevel: val('#logLevel'),
    debugHttp: q('#debugHttp').checked,
    allowSelfSigned: q('#allowSelfSigned').checked
  };
  const r = await fetch('/api/app', {
    method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  });
  const j = await r.json();
  j.ok ? toast('Settings saved','ok') : toast(j.message || 'Save failed','bad');
}

/* -------- Save host (validates before commit) -------- */
async function saveHost(ev){
  ev.preventDefault();
  const payload = {
    name: val('#name').trim(),
    baseUrl: val('#baseUrl').trim(),
    mac: val('#mac').trim(),
    token: val('#token').trim(),
    oldBaseUrl: val('#oldBaseUrl').trim() || undefined
  };
  const r = await fetch('/api/settings/host', {
    method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify(payload)
  });
  const j = await r.json();
  if (j.ok) {
    toast('Host saved','ok');
    ['#name','#baseUrl','#mac','#token','#oldBaseUrl'].forEach(s=>setVal(s,''));
    await refreshHosts();
  } else {
    toast(j.message || 'Save failed','bad');
  }
}

/* -------- Bootstrap -------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  await buildShell('settings');
  initTabs();
  await loadAppSettings();
  await refreshHosts();
  q('#hostForm').addEventListener('submit', saveHost);
  q('#saveApp').addEventListener('click', saveAppSettings);
});