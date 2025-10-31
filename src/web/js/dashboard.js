async function loadServers(){
  const tbody = document.getElementById('serversBody');
  const empty = document.getElementById('serversEmpty');
  tbody.innerHTML = '';
  try{
    const rows = await jsonFetch('/api/servers');
    if (!rows.length){ empty.style.display = ''; return; }
    empty.style.display = 'none';
    for (const r of rows){
      const tr = document.createElement('tr');
      const sys = r.status?.system;
      const arr = r.status?.system?.array?.status || r.status?.system?.array || '';
      const docker = r.status?.docker ? `${r.status.docker.running}/${r.status.docker.total}` : '—';
      const vms = r.status?.vms ? `${r.status.vms.running}/${r.status.vms.total}` : '—';
      tr.innerHTML = `
        <td>${r.name || '—'}</td>
        <td><a href="${r.baseUrl}" target="_blank" rel="noopener">${r.baseUrl}</a></td>
        <td>${arr || '—'}</td>
        <td>${docker}</td>
        <td>${vms}</td>
        <td>${r.error ? `<span class="pill red" title="${r.error}">Error</span>` : '<span class="pill green">OK</span>'}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (e){
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Failed to load servers: ${e.message}</td></tr>`;
  }
}

document.addEventListener('DOMContentLoaded', loadServers);
