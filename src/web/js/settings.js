const nameEl    = $('#name');
const baseEl    = $('#baseUrl');
const macEl     = $('#mac');
const tokenEl   = $('#token');
const oldBaseEl = $('#editOldBase');
const respEl    = $('#resp');
const hostsBody = $('#hostsBody');
const hostsEmpty= $('#hostsEmpty');

$('#toggleToken').addEventListener('click', () => {
  tokenEl.type = tokenEl.type === 'password' ? 'text' : 'password';
  $('#toggleToken').textContent = tokenEl.type === 'password' ? 'Show' : 'Hide';
});

function setBadge(el, ok, msg){
  el.className = 'resp ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
}

/* Load saved hosts */
async function loadHosts(){
  hostsBody.innerHTML = '';
  try{
    const rows = await jsonFetch('/api/settings/hosts');
    if (!rows.length){ hostsEmpty.style.display = ''; return; }
    hostsEmpty.style.display = 'none';
    for (const h of rows){
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="Name">${h.name}</td>
        <td data-label="Base URL"><a href="${h.baseUrl}" target="_blank" rel="noopener">${h.baseUrl}</a></td>
        <td data-label="MAC">${h.mac}</td>
        <td data-label="Token">${h.tokenSet ? '<span class="pill green">set</span>' : '<span class="pill">none</span>'}</td>
        <td data-label="Actions" class="row-actions">
          <button class="btn ghost test" data-base="${h.baseUrl}">Test</button>
          <button class="btn ghost edit" data-base="${h.baseUrl}" data-name="${h.name}" data-mac="${h.mac}">Edit</button>
          <button class="btn ghost danger del" data-base="${h.baseUrl}">Delete</button>
        </td>
      `;
      hostsBody.appendChild(tr);
    }
  } catch(e){
    hostsBody.innerHTML = `<tr><td colspan="5" class="muted">Failed to load hosts: ${e.message}</td></tr>`;
  }
}

/* Per-row actions */
hostsBody.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button'); if (!btn) return;
  const base = btn.dataset.base;

  if (btn.classList.contains('test')){
    btn.disabled = true; const txt = btn.textContent; btn.textContent = 'Testing…';
    try { await jsonFetch(`/api/settings/test?base=${encodeURIComponent(base)}`); setBadge(respEl,true,`✅ Connection OK: ${base}`); }
    catch(e){ setBadge(respEl,false,`❌ ${e.message}`); }
    finally { btn.disabled=false; btn.textContent=txt; }
  }

  if (btn.classList.contains('edit')){
    nameEl.value = btn.dataset.name || '';
    baseEl.value = base || '';
    macEl.value  = btn.dataset.mac || '';
    oldBaseEl.value = base || '';
    $('#cancelEdit').style.display = '';
    nameEl.focus();
  }

  if (btn.classList.contains('del')){
    if (!confirm(`Delete host ${base}?`)) return;
    btn.disabled = true;
    try { await jsonFetch(`/api/settings/host?base=${encodeURIComponent(base)}`, { method:'DELETE' }); await loadHosts(); setBadge(respEl,true,`🗑️ Deleted ${base}`); }
    catch(e){ setBadge(respEl,false,`❌ ${e.message}`); }
    finally { btn.disabled=false; }
  }
});

/* Cancel edit */
$('#cancelEdit').addEventListener('click', () => {
  nameEl.value = baseEl.value = macEl.value = tokenEl.value = '';
  oldBaseEl.value = '';
  $('#cancelEdit').style.display = 'none';
  respEl.textContent = '';
  respEl.className = 'resp muted';
});

/* Transactional Save Host */
$('#saveHost').addEventListener('click', async () => {
  const body = {
    name:  nameEl.value.trim(),
    baseUrl: baseEl.value.trim(),
    mac:   macEl.value.trim(),
    token: tokenEl.value.trim(),
    oldBaseUrl: oldBaseEl.value.trim() || undefined
  };
  if (!body.name || !body.baseUrl || !body.mac || !body.token) {
    setBadge(respEl,false,'Please fill in Name, Base URL, MAC, and Token.'); return;
  }
  $('#saveHost').disabled = true; setBadge(respEl,true,'Validating…');
  try{
    await jsonFetch('/api/settings/host', { method:'POST', body: JSON.stringify(body) });
    // success
    nameEl.value = baseEl.value = macEl.value = tokenEl.value = '';
    oldBaseEl.value = '';
    $('#cancelEdit').style.display = 'none';
    await loadHosts();
    setBadge(respEl,true,'✅ Host saved and validated.');
  } catch(e){
    setBadge(respEl,false,`❌ ${e.message}`);
  } finally { $('#saveHost').disabled = false; }
});

/* ------------------------------- App Settings --------------------------- */
async function loadApp(){
  try {
    const r = await jsonFetch('/api/app');
    const s = r.settings || {};
    $('#appLogLevel').value = s.logLevel || 'info';
    $('#appDebugHttp').value = String(!!s.debugHttp);
    $('#appSelfSigned').value = String(!!s.allowSelfSigned);
  } catch {}
}
$('#saveApp').addEventListener('click', async ()=>{
  const body = {
    logLevel: $('#appLogLevel').value,
    debugHttp: $('#appDebugHttp').value === 'true',
    allowSelfSigned: $('#appSelfSigned').value === 'true'
  };
  const badge = $('#appResp');
  try {
    await jsonFetch('/api/app', { method:'POST', body: JSON.stringify(body) });
    setBadge(badge, true, '✅ Saved. Changes apply immediately.');
  } catch(e) {
    setBadge(badge, false, `❌ ${e.message}`);
  }
});

document.addEventListener('DOMContentLoaded', async ()=>{ await loadHosts(); await loadApp(); });
