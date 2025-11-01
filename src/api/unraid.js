import fetch from 'node-fetch';
import https from 'https';
import { getToken } from '../store/configStore.js';

/* ---------------- TLS + helpers ---------------- */
const allowSelfSigned = (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true';
const httpsAgent = new https.Agent({ rejectUnauthorized: !allowSelfSigned });

function agentFor(u) {
  const p = new URL(u).protocol;
  return p === 'https:' ? httpsAgent : undefined;
}
function netHint(err) {
  const m = String(err?.message || '').toLowerCase();
  if (m.includes('self signed')) return 'TLS failed (self-signed). Enable UNRAID_ALLOW_SELF_SIGNED=true.';
  if (m.includes('unauthorized') || m.includes('401')) return 'Unauthorized. Check Unraid API token.';
  if (m.includes('econnrefused')) return 'Connection refused.';
  if (m.includes('getaddrinfo') || m.includes('dns')) return 'DNS problem.';
  if (m.includes('timeout')) return 'Request timed out.';
  return null;
}
async function httpJSON(url, opts) {
  let res;
  try { res = await fetch(url, { ...opts, agent: agentFor(url) }); }
  catch (e) { throw new Error(netHint(e) || `Network error: ${e.message}`); }
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

/* ---------------- GraphQL core (w/ schema fallbacks) ---------------- */
async function gql(baseUrl, query, variables = {}) {
  const token = getToken(baseUrl);
  if (!token) throw new Error(`No API token configured for ${baseUrl}`);
  const endpoint = new URL('/graphql', baseUrl).toString();
  const { ok, status, json } = await httpJSON(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'x-api-key': token
    },
    body: JSON.stringify({ query, variables })
  });
  if (!ok) {
    const msg = (json?.errors && json.errors[0]?.message) || `HTTP ${status}`;
    throw new Error(`HTTP ${status} from ${endpoint}: ${msg}`);
  }
  if (json?.errors?.length) {
    const msg = json.errors.map(e => e.message).join('; ');
    const err = new Error(msg); err._validation = /cannot query field/i.test(msg); throw err;
  }
  return json.data;
}
async function tryQueries(baseUrl, variants, variables) {
  let lastErr;
  for (const q of variants) {
    try { return await gql(baseUrl, q, variables); }
    catch (e) { lastErr = e; if (!e._validation) break; }
  }
  throw lastErr;
}

/* ---------------- Query variants ---------------- */

/* System + array (state/status) */
const Q_INFO_ARRAY = [
  `query { info { os { distro release uptime } } array { state } }`,
  `query { system { hostname osVersion uptime } array { status } }`
];

/* Parity / array operations (several shapes across versions) */
const Q_PARITY = [
  `query { array { operation { type progress state error } } }`,
  `query { array { parityCheck { progress state error } } }`,
  `query { array { tasks { kind progress status error } } }`,
];

/* Capacity variants */
const Q_ARRAY_CAPACITY = [
  `query { array { capacity { total used free } } }`,
  `query { array { capacity { total free } } }`,
  `query { array { size free } }`
];

/* CPU/RAM variants */
const Q_HOST_METRICS = [
  `query { metrics { cpu { percent } memory { percentUsed } } }`,
  `query { host { cpuPct memoryPct } }`,
  `query { resources { cpuPercent memPercent } }`
];

/* Docker & VMs (unchanged) */
const Q_DOCKERS = [
  `query { docker { containers { id names image status state autoStart } } }`,
  `query { docker { list { id name image status state } } }`
];
const Q_VMS = [
  `query { vms { domains { id name state } } }`,
  `query { vms { domain(id:"*") { id name state } } }`
];

/* ---------------- Status classifier ---------------- */
function classifyStatus(arrayState, parity, errText) {
  // arrayState: 'STARTED' | 'STOPPED' | 'MAINTENANCE' | etc or undefined
  if (errText) return { code: 'error', label: errText };
  if (!arrayState) return { code: 'unknown', label: 'Unknown' };

  // Active parity?
  const p = parity;
  const hasProgress = typeof p?.progress === 'number' && p.progress >= 0 && p.progress <= 100;
  const isParityActive = /check|parity/i.test(String(p?.type || p?.state || p?.status || '')) || hasProgress;

  if (String(arrayState).toUpperCase() !== 'STARTED') {
    return { code: 'stopped', label: String(arrayState).toUpperCase() };
  }
  if (isParityActive) {
    const pct = hasProgress ? Math.round(p.progress) : null;
    return { code: 'parity', label: pct != null ? `Parity Check ${pct}%` : 'Parity Check' };
  }
  return { code: 'ok', label: 'OK' };
}

/* ---------------- Public: unified host status ---------------- */
export async function getHostStatus(baseUrl) {
  // Assume offline until a request succeeds
  let offline = false;
  try {
    const sys = await tryQueries(baseUrl, Q_INFO_ARRAY);

    // basic info
    let arrayState = sys.array?.state || sys.array?.status || null;
    // parity
    let parityInfo = null;
    try {
      const p = await tryQueries(baseUrl, Q_PARITY);
      const a = p?.array || {};
      // normalize to {progress?, state/kind/status?, error?}
      parityInfo =
        a.operation ?? a.parityCheck ??
        (Array.isArray(a.tasks) ? a.tasks.find(t=>/parity|check/i.test(t.kind||'')) : null) ?? null;
    } catch { /* schema may not expose parity when idle */ }

    // metrics
    let cpuPct = null, ramPct = null;
    try {
      const m = await tryQueries(baseUrl, Q_HOST_METRICS);
      if (m.metrics) {
        cpuPct = m.metrics.cpu?.percent ?? null;
        ramPct = m.metrics.memory?.percentUsed ?? null;
      } else if (m.host) {
        cpuPct = m.host.cpuPct ?? null;
        ramPct = m.host.memoryPct ?? null;
      } else if (m.resources) {
        cpuPct = m.resources.cpuPercent ?? null;
        ramPct = m.resources.memPercent ?? null;
      }
    } catch { /* leave nulls */ }

    // storage %
    let storagePct = null;
    try {
      const cap = await tryQueries(baseUrl, Q_ARRAY_CAPACITY);
      if (cap.array?.capacity) {
        const t = Number(cap.array.capacity.total ?? 0);
        const u = Number(cap.array.capacity.used ?? NaN);
        const f = Number(cap.array.capacity.free ?? NaN);
        if (t > 0) {
          if (!isNaN(u)) storagePct = Math.round((u / t) * 100);
          else if (!isNaN(f)) storagePct = Math.round(((t - f) / t) * 100);
        }
      } else if (cap.array?.size != null && cap.array?.free != null) {
        const t = Number(cap.array.size), f = Number(cap.array.free);
        if (t > 0) storagePct = Math.round(((t - f) / t) * 100);
      }
    } catch { /* ignore */ }

    // small summaries
    let dockerRun = 0, dockerTot = 0, vmRun = 0, vmTot = 0;
    try {
      const d = await tryQueries(baseUrl, Q_DOCKERS);
      const arr = d.docker?.containers || d.docker?.list || [];
      dockerTot = arr.length;
      dockerRun = arr.filter(c => (c.state || '').toLowerCase() === 'running' ||
        String(c.status||'').toLowerCase().includes('up')).length;
    } catch {}
    try {
      const v = await tryQueries(baseUrl, Q_VMS);
      const doms = v?.vms?.domains || [];
      vmTot = doms.length;
      vmRun = doms.filter(x => String(x.state).toLowerCase() === 'running').length;
    } catch {}

    const status = classifyStatus(arrayState, parityInfo, null);

    return {
      ok: true,
      data: {
        system: { array: { status: arrayState } },
        status, // {code,label}
        docker: { running: dockerRun, total: dockerTot },
        vms: { running: vmRun, total: vmTot },
        metrics: { cpuPct, ramPct, storagePct }
      }
    };
  } catch (e) {
    offline = true;
    return { ok: false, error: e.message || String(e) };
  } finally {
    // nothing to do here; offline handled by caller
  }
}

/* Containers / VMs (unchanged) */
export async function listContainers(baseUrl) {
  const d = await tryQueries(baseUrl, Q_DOCKERS);
  const arr = d.docker?.containers || d.docker?.list || [];
  return arr.map(c => ({
    id: c.id,
    name: Array.isArray(c.names) ? (c.names[0] || c.id) : (c.name || c.id),
    image: c.image || '',
    state: c.state || (String(c.status || '').toLowerCase().includes('up') ? 'running' : 'stopped')
  }));
}
export async function listVMs(baseUrl) {
  try {
    const d = await tryQueries(baseUrl, Q_VMS);
    const arr = d?.vms?.domains || [];
    return arr.map(v => ({ id: v.id, name: v.name, state: v.state }));
  } catch { return []; }
}

/* Mutations (same as before) */
export async function containerAction(baseUrl, id, action) {
  if (action === 'restart') {
    await containerAction(baseUrl, id, 'stop');
    return containerAction(baseUrl, id, 'start');
  }
  const field = (action === 'start' ? 'start' : 'stop');
  const queries = [
    `mutation($id:ID!){ docker { ${field}(id:$id) } }`,
    `mutation($id:String!){ docker { ${field}(containerId:$id) } }`,
    `mutation{ docker { ${field}(id:"${id}") } }`
  ];
  let lastErr;
  for (const [i,q] of queries.entries()) {
    try { await gql(baseUrl, q, i===0?{id}:{id}); return true; }
    catch (e){ lastErr = e; if (!e._validation) break; }
  }
  throw lastErr;
}
export async function vmAction(baseUrl, id, action) {
  const allowed = new Set(['start','stop','pause','resume','forceStop','reboot','reset']);
  if (!allowed.has(action)) throw new Error(`Unsupported VM action: ${action}`);
  const queries = [
    `mutation($id:ID!){ vm { ${action}(id:$id) } }`,
    `mutation($id:String!){ vm { ${action}(domainId:$id) } }`,
    `mutation{ vm { ${action}(id:"${id}") } }`
  ];
  let lastErr;
  for (const [i,q] of queries.entries()) {
    try { await gql(baseUrl, q, i===0?{id}:{id}); return true; }
    catch (e){ lastErr = e; if (!e._validation) break; }
  }
  throw lastErr;
}
export async function powerAction() {
  throw new Error('System power actions are not available via this Unraid API.');
}