import { q, val, setVal, toast } from './common.js';

/* ---------- Sidebar navigation (Sonarr-style) ---------- */
function initSidebar(){
  const items = document.querySelectorAll('.settings-sidebar .sideitem');
  const panes = document.querySelectorAll('.setting-pane');
  items.forEach(btn=>{
    btn.onclick = ()=>{
      items.forEach(b=>b.classList.remove('active'));
      panes.forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      q(`#pane-${btn.dataset.target}`).classList.add('active');
      // mobile UX: scroll to content
      q('.settings-content').scrollIntoView({behavior:'smooth', block:'start'});
    };
  });
}

/* ----------------------- Hosts table ----------------------- */
async function refreshHosts(){
  const r = await fetch('/api/settings/hosts');
  const arr = await r.json();
  const tbody = q('#hosts-body'); tbody.innerHTML = '';
  arr.forEach(h=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-col="Name">${h.name}</td>
      <td data-col="Address">${h.baseUrl}</td>
      <td data-col="MAC">${h.mac}</td>
      <td data-col="Token">${h.tokenSet ? '<span class="pill ok">Validated</span>' : '<span class="pill bad">Not Set</span>'}</td>
      <td class="act" data-col="Actions">
        <button class="btn sm" data-act="edit">Edit</button>
        <button class="btn sm" data-act="test">Test</button>
        <button class="btn sm danger" data-act="del">Delete</button>
      </td>`;
    tr.querySelector('[data-act="test"]').onclick = async()=>{
      const r = await fetch(`/api/settings/test?base=${encodeURIComponent(h.baseUrl)}`);
      const j = await r.json();
      j.ok ? toast('Test OK','ok') : toast(j.message || 'Test failed','bad');
      refreshHosts();
    };
    tr.querySelector('[data-act="del"]').onclick = async()=>{
      await fetch(`/api/settings/host?base=${encodeURIComponent(h.baseUrl)}`, { method:'DELETE' });
      toast('Deleted','ok'); refreshHosts();
    };
    tr.querySelector('[data-act="edit"]').onclick = ()=>{
      setVal('#name', h.name);
      setVal('#baseUrl', h.baseUrl);
      setVal('#mac', h.mac);
      setVal('#oldBaseUrl', h.baseUrl);
      q('#name').focus();
      document.getElementById('hostForm').scrollIntoView({behavior:'smooth', block:'start'});
    };
    tbody.appendChild(tr);
  });
}

/* -------------------- App settings load/save ------------------- */
async function loadAppSettings(){
  const r = await fetch('/api/app');
  const j = await r.json();
  setVal('#refreshSeconds', j?.settings?.refreshSeconds ?? 30);
  setVal('#logLevel', j?.settings?.logLevel ?? 'info');
  q('#debugHttp').checked = !!j?.settings?.debugHttp;
  q('#allowSelfSigned').checked = !!j?.settings?.allowSelfSigned;
}
async function saveAppSettings(){
  const body = {
    refreshSeconds: Number(val('#refreshSeconds')),
    logLevel: val('#logLevel'),
    debugHttp: q('#debugHttp').checked,
    allowSelfSigned: q('#allowSelfSigned').checked
  };
  const r = await fetch('/api/app', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify(body)
  });
  const j = await r.json();
  j.ok ? toast('Settings saved','ok') : toast(j.message || 'Save failed','bad');
}

/* --------------------------- Save host --------------------------- */
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
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload)
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

/* ------------------------------ bootstrap ------------------------------ */
window.addEventListener('DOMContentLoaded', async ()=>{
  initSidebar();
  await loadAppSettings();
  await refreshHosts();
  q('#hostForm').addEventListener('submit', saveHost);
  q('#saveApp').addEventListener('click', saveAppSettings);
});