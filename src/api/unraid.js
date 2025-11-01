import fetch from 'node-fetch';
import https from 'https';
import { getToken } from '../store/configStore.js';

/* ========================= TLS & helpers ========================= */

const allowSelfSigned = (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true';
const httpsAgent = new https.Agent({ rejectUnauthorized: !allowSelfSigned });

function agentFor(urlString) {
  const u = new URL(urlString);
  if (u.protocol === 'https:') return httpsAgent;
  if (u.protocol === 'http:') return undefined;
  throw new Error(`Unsupported protocol: ${u.protocol}`);
}

function netHint(err) {
  const m = String(err?.message || '').toLowerCase();
  if (m.includes('self signed')) return 'TLS failed: self-signed certificate. Enable UNRAID_ALLOW_SELF_SIGNED=true or use a trusted cert.';
  if (m.includes('unauthorized') || m.includes('401')) return 'Unauthorized. Check Unraid API key.';
  if (m.includes('econnrefused')) return 'Connection refused by Unraid host.';
  if (m.includes('getaddrinfo') || m.includes('dns')) return 'DNS resolution problem.';
  if (m.includes('timeout')) return 'Request timed out.';
  return null;
}

async function httpJSON(endpoint, opts) {
  let res;
  try { res = await fetch(endpoint, { ...opts, agent: agentFor(endpoint) }); }
  catch (e) { throw new Error(netHint(e) || `Network error: ${e.message || e}`); }
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

/* ============================ GraphQL core ============================= */

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
    const err = new Error(msg);
    err._validation = /cannot query field/i.test(msg);
    throw err;
  }
  return json.data;
}

async function tryQueries(baseUrl, variants, variables) {
  let lastErr;
  for (const q of variants) {
    try { return await gql(baseUrl, q, variables); }
    catch (e) {
      lastErr = e;
      if (!e._validation) break; // stop on non-schema errors
    }
  }
  throw lastErr;
}

/* ======================== Query variants (adaptive) ===================== */

const Q_INFO_ARRAY = [
  `query {
     info { os { distro release uptime } }
     array { state }
   }`,
  `query {
     system { hostname osVersion uptime }
     array { status }
   }`
];

/* Capacity fallbacks across schema versions */
const Q_ARRAY_CAPACITY = [
  `query { array { capacity { total used free } } }`,
  `query { array { capacity { total free } } }`,
  `query { array { size free } }`
];

/* CPU/RAM fallbacks (names vary by builds) */
const Q_HOST_METRICS = [
  `query { metrics { cpu { percent } memory { percentUsed } } }`,
  `query { host { cpuPct memoryPct } }`,
  `query { resources { cpuPercent memPercent } }`
];

/* Docker listing */
const Q_DOCKERS = [
  `query { docker { containers { id names image status state autoStart } } }`,
  `query { docker { list { id name image status state } } }`
];

const Q_VMS = [
  `query { vms { domains { id name state } } }`,
  `query { vms { domain(id:"*") { id name state } } }`
];

/* ============================ Public functions ========================== */

export async function getHostStatus(baseUrl) {
  try {
    const sys = await tryQueries(baseUrl, Q_INFO_ARRAY);

    // normalize info/system
    let hostname='(Unraid)', osVersion='', uptime=null, arrayStatus='—';
    if (sys.info?.os) {
      hostname = sys.info.os.distro || hostname;
      osVersion = sys.info.os.release || osVersion;
      uptime = sys.info.os.uptime ?? uptime;
    } else if (sys.system) {
      hostname = sys.system.hostname || hostname;
      osVersion = sys.system.osVersion || osVersion;
      uptime = sys.system.uptime ?? uptime;
    }
    arrayStatus = sys.array?.state || sys.array?.status || '—';

    // metrics: cpu & ram
    let cpuPct=null, ramPct=null;
    try {
      const m = await tryQueries(baseUrl, Q_HOST_METRICS);
      if (m.metrics) {
        cpuPct = m.metrics.cpu?.percent ?? cpuPct;
        ramPct = m.metrics.memory?.percentUsed ?? ramPct;
      } else if (m.host) {
        cpuPct = m.host.cpuPct ?? cpuPct;
        ramPct = m.host.memoryPct ?? ramPct;
      } else if (m.resources) {
        cpuPct = m.resources.cpuPercent ?? cpuPct;
        ramPct = m.resources.memPercent ?? ramPct;
      }
    } catch { /* ignore */ }

    // capacity → storage %
    let storagePct=null;
    try {
      const cap = await tryQueries(baseUrl, Q_ARRAY_CAPACITY);
      // Variant A/B
      if (cap.array?.capacity) {
        const t = Number(cap.array.capacity.total ?? 0);
        const u = Number(cap.array.capacity.used ?? NaN);
        const f = Number(cap.array.capacity.free ?? NaN);
        if (t > 0) {
          if (!isNaN(u)) storagePct = Math.round((u / t) * 100);
          else if (!isNaN(f)) storagePct = Math.round(((t - f) / t) * 100);
        }
      }
      // Variant C (size/free)
      else if (cap.array?.size != null && cap.array?.free != null) {
        const t = Number(cap.array.size);
        const f = Number(cap.array.free);
        if (t > 0) storagePct = Math.round(((t - f) / t) * 100);
      }
    } catch { /* ignore */ }

    // containers count
    const dock = await tryQueries(baseUrl, Q_DOCKERS);
    let containers = [];
    if (dock.docker?.containers) containers = dock.docker.containers;
    else if (dock.docker?.list) containers = dock.docker.list;

    const mapped = containers.map(c => ({
      id: c.id,
      name: Array.isArray(c.names) ? (c.names[0] || c.id) : (c.name || c.id),
      image: c.image || '',
      state: c.state || (String(c.status || '').toLowerCase().includes('up') ? 'running' : 'stopped')
    }));
    const running = mapped.filter(c => String(c.state).toLowerCase() === 'running').length;

    // vms
    let vCount = 0, vRun = 0;
    try {
      const v = await tryQueries(baseUrl, Q_VMS);
      const domains = v?.vms?.domains || [];
      vCount = domains.length;
      vRun = domains.filter(d => String(d.state).toLowerCase() === 'running').length;
    } catch { /* schema might omit vms; ignore */ }

    return {
      ok: true,
      data: {
        system: { hostname, osVersion, uptime, array: { status: arrayStatus } },
        docker: { running, total: mapped.length },
        vms: { running: vRun, total: vCount },
        metrics: { cpuPct, ramPct, storagePct }
      }
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

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
  } catch {
    return [];
  }
}

/* Mutations remain unchanged */
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
  const vars = [{ id }, { id }];
  await tryMutations(baseUrl, queries, vars);
  return true;
}
async function tryMutations(baseUrl, variants, variablesList) {
  let lastErr;
  for (let i = 0; i < variants.length; i++) {
    try { return await gql(baseUrl, variants[i], variablesList[i] || {}); }
    catch (e) { lastErr = e; if (!e._validation) break; }
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
  const vars = [{ id }, { id }];
  await tryMutations(baseUrl, queries, vars);
  return true;
}

export async function powerAction(_baseUrl, _action) {
  throw new Error('System power actions are not available via this Unraid API.');
}