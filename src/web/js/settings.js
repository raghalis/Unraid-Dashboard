const nameEl    = $('#name');
const baseEl    = $('#baseUrl');
const macEl     = $('#mac');
const tokenEl   = $('#token');
const respEl    = $('#resp');
const hostsBody = $('#hostsBody');
const hostsEmpty= $('#hostsEmpty');

$('#toggleToken').addEventListener('click', () => {
  tokenEl.type = tokenEl.type === 'password' ? 'text' : 'password';
  $('#toggleToken').textContent = tokenEl.type === 'password' ? 'Show' : 'Hide';
});

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
        <td>${h.name}</td>
        <td><a href="${h.baseUrl}" target="_blank" rel="noopener">${h.baseUrl}</a></td>
        <td>${h.mac}</td>
        <td>${h.tokenSet ? '<span class="pill green">set</span>' : '<span class="pill">none</span>'}</td>
        <td class="row-actions">
          <button class="btn ghost test" data-base="${h.baseUrl}">Test</button>
          <button class="btn ghost danger del" data-base="${h.baseUrl}">Delete</button>
        </td>
      `;
      hostsBody.appendChild(tr);
    }
  } catch(e){
    hostsBody.innerHTML = `<tr><td colspan="5" class="muted">Failed to load hosts: ${e.message}</td></tr>`;
  }
}

/* Wire per-row actions */
hostsBody.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const base = btn.dataset.base;

  if (btn.classList.contains('test')){
    btn.disabled = true; btn.textContent = 'Testing…';
    try {
      await jsonFetch(`/api/settings/test?base=${encodeURIComponent(base)}`);
      setBadge(respEl, true, `✅ Connection OK for ${base}`);
    } catch(e){
      setBadge(respEl, false, `❌ ${e.message}`);
    } finally {
      btn.disabled = false; btn.textContent = 'Test';
    }
  }

  if (btn.classList.contains('del')){
    if (!confirm(`Delete host ${base}?`)) return;
    btn.disabled = true;
    try{
      await jsonFetch(`/api/settings/host?base=${encodeURIComponent(base)}`, { method:'DELETE' });
      await loadHosts();
      setBadge(respEl, true, `🗑️ Deleted ${base}`);
    } catch(e){
      setBadge(respEl, false, `❌ ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  }
});

/* Transactional Save Host (server validates before persisting) */
$('#saveHost').addEventListener('click', async () => {
  const name  = nameEl.value.trim();
  const base  = baseEl.value.trim();
  const mac   = macEl.value.trim();
  const token = tokenEl.value.trim();

  if (!name || !base || !mac){
    setBadge(respEl, false, 'Please fill in Name, Base URL, and MAC.');
    return;
  }

  $('#saveHost').disabled = true; setBadge(respEl, true, 'Validating…');

  try{
    const body = { name, baseUrl: base, mac, token };
    await jsonFetch('/api/settings/host', { method:'POST', body: JSON.stringify(body) });
    // success: clear input fields & refresh table
    nameEl.value = ''; baseEl.value = ''; macEl.value = ''; tokenEl.value = '';
    await loadHosts();
    setBadge(respEl, true, '✅ Host saved and validated.');
  } catch(e){
    // failure: keep inputs
    setBadge(respEl, false, `❌ ${e.message}`);
  } finally {
    $('#saveHost').disabled = false;
  }
});

/* Initial load */
document.addEventListener('DOMContentLoaded', loadHosts);
