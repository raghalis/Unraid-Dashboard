function pct(v){ return (v===null || v===undefined || Number.isNaN(v)) ? '—' : `${v}%`; }

async function loadServers(){
  const tbody = document.getElementById('serversBody');
  const empty = document.getElementById('serversEmpty');
  tbody.innerHTML = '';
  try{
    const rows = await jsonFetch('/api/servers');
    if (!rows.length){ empty.style.display = ''; return; }
    empty.style.display = 'none';
    for (const r of rows){
      const arrStatus = r.status?.system?.array?.status || '';
      const m = r.status?.metrics || {};
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="Name">${r.name || '—'}</td>
        <td data-label="Base URL"><a href="${r.baseUrl}" target="_blank" rel="noopener">${r.baseUrl}</a></td>
        <td data-label="Array">${arrStatus || '—'}</td>
        <td data-label="CPU%">${pct(m.cpuPct)}</td>
        <td data-label="RAM%">${pct(m.ramPct)}</td>
        <td data-label="Storage%">${pct(m.storagePct)}</td>
        <td data-label="Status">
          ${r.error ? `<span class="pill red" title="${r.error}">Error</span>` : '<span class="pill green" title="API reachable and status fetched">OK</span>'}
        </td>
      `;
      tbody.appendChild(tr);
    }
  } catch (e){
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Failed to load servers: ${e.message}</td></tr>`;
  }
}
document.addEventListener('DOMContentLoaded', loadServers);
