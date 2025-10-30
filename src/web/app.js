async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function refreshAll() {
  const servers = await getJSON('/api/servers');
  const g = document.getElementById('grid');
  g.innerHTML = '';
  for (const s of servers) g.append(renderServer(s));
}

function renderServer(s) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="title">${s.name}</div>
    <div class="muted mono">${s.baseUrl}</div>
    <div class="section row">
      <span class="pill">OS: ${s.status?.system?.osVersion ?? 'n/a'}</span>
      <span class="pill">Uptime: ${s.status?.system?.uptime ?? 'n/a'}</span>
      <span class="pill">Array: ${s.status?.system?.array?.status ?? 'unknown'}</span>
    </div>
    <div class="row" style="margin-top:8px">
      <button onclick="act('${s.baseUrl}','power','wake')">WOL</button>
      <button onclick="act('${s.baseUrl}','power','reboot')">Reboot</button>
      <button onclick="act('${s.baseUrl}','power','shutdown')">Shutdown</button>
      <button onclick="loadDetails('${s.baseUrl}','docker')">Load Containers</button>
      <button onclick="loadDetails('${s.baseUrl}','vms')">Load VMs</button>
    </div>
    <div class="section">
      <div id="list-${btoa(s.baseUrl)}" class="list"></div>
    </div>
  `;
  return el;
}

async function act(baseUrl, kind, what) {
  const body = JSON.stringify({ action: what });
  const res = await getJSON(`/api/host?action=${kind}&base=${encodeURIComponent(baseUrl)}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body
  });
  alert(`${kind} ${what}: ${res.ok ? 'OK' : 'Failed'}`);
}

async function loadDetails(baseUrl, type) {
  const list = document.getElementById(`list-${btoa(baseUrl)}`);
  list.innerHTML = 'Loading...';
  const data = await getJSON(`/api/host/${type}?base=${encodeURIComponent(baseUrl)}`);
  list.innerHTML = '';
  if (type === 'docker') {
    for (const c of data) {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `
        <div><b>${c.name}</b><div class="muted mono">${c.image}</div></div>
        <div class="row">
          <span class="pill">${c.state}</span>
          <button onclick="containerAction('${baseUrl}','${c.id}','start')">Start</button>
          <button onclick="containerAction('${baseUrl}','${c.id}','stop')">Stop</button>
          <button onclick="containerAction('${baseUrl}','${c.id}','restart')">Restart</button>
        </div>`;
      list.append(row);
    }
  } else {
    for (const v of data) {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `
        <div><b>${v.name}</b><div class="muted mono">${v.id}</div></div>
        <div class="row">
          <span class="pill">${v.state}</span>
          <button onclick="vmAction('${baseUrl}','${v.id}','start')">Start</button>
          <button onclick="vmAction('${baseUrl}','${v.id}','stop')">Stop</button>
          <button onclick="vmAction('${baseUrl}','${v.id}','reset')">Reset</button>
        </div>`;
      list.append(row);
    }
  }
}

async function containerAction(baseUrl, id, action) {
  const res = await getJSON(`/api/host/docker/action?base=${encodeURIComponent(baseUrl)}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ id, action })
  });
  alert(`Container ${action}: ${res.ok ? 'OK' : 'Failed'}`);
}

async function vmAction(baseUrl, id, action) {
  const res = await getJSON(`/api/host/vm/action?base=${encodeURIComponent(baseUrl)}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ id, action })
  });
  alert(`VM ${action}: ${res.ok ? 'OK' : 'Failed'}`);
}

refreshAll().catch(console.error);
