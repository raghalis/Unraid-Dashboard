const rows = document.getElementById('rows');
const statusEl = document.getElementById('status');

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : '{}'
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function loadHosts() {
  const res = await fetch('/api/settings/hosts', { headers: {} });
  const json = await res.json();
  rows.innerHTML = '';
  for (const h of json.hosts) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${h.name || ''}</td>
      <td>${h.baseUrl || ''}</td>
      <td>${h.mac || ''}</td>
      <td>${h.token ? '✔︎' : '—'}</td>
      <td><button data-test="${h.baseUrl}">Test</button></td>
    `;
    rows.appendChild(tr);
  }
  rows.querySelectorAll('button[data-test]').forEach(btn => {
    btn.addEventListener('click', async () => {
      writeStatus('Testing…');
      try {
        const r = await api('/api/settings/test', { baseUrl: btn.dataset.test });
        writeStatus(`OK: ${r.message}`);
      } catch (e) {
        writeStatus(`Error: ${e.message}`);
      }
    });
  });
}

function writeStatus(msg) { statusEl.textContent = msg; }

document.getElementById('saveHost').addEventListener('click', async () => {
  writeStatus('');
  const name = document.getElementById('name').value.trim();
  const base = document.getElementById('base').value.trim();
  const mac  = document.getElementById('mac').value.trim();
  try {
    await api('/api/settings/hosts', { name, baseUrl: base, mac });
    writeStatus('Saved.');
    await loadHosts();
  } catch (e) {
    writeStatus(`Error: ${e.message}`);
  }
});

document.getElementById('setToken').addEventListener('click', async () => {
  const base = document.getElementById('base').value.trim();
  const token = prompt('Paste Unraid API key for this host:');
  if (!token) return;
  try {
    await api('/api/settings/token', { baseUrl: base, token });
    writeStatus('Token saved.');
    await loadHosts();
  } catch (e) {
    writeStatus(`Error: ${e.message}`);
  }
});

document.getElementById('testConn').addEventListener('click', async () => {
  const base = document.getElementById('base').value.trim();
  try {
    const r = await api('/api/settings/test', { baseUrl: base });
    writeStatus(`OK: ${r.message}`);
  } catch (e) {
    writeStatus(`Error: ${e.message}`);
  }
});

document.getElementById('runProbe').addEventListener('click', async () => {
  const base = document.getElementById('probeBase').value.trim();
  const out = document.getElementById('probeOut');
  out.textContent = 'Running…';
  try {
    const r = await api('/api/probe', { baseUrl: base });
    out.textContent = JSON.stringify(r.data, null, 2);
  } catch (e) {
    out.textContent = `Error: ${e.message}`;
  }
});

loadHosts().catch(console.error);
