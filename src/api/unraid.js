import fetch from 'node-fetch';
import https from 'https';
import { getToken, getAppSettings } from '../store/configStore.js';

/* ============================ helpers ============================ */

function agentFor(urlString) {
  const u = new URL(urlString);
  if (u.protocol !== 'https:') return undefined;
  const { allowSelfSigned } = getAppSettings();
  return new https.Agent({ rejectUnauthorized: !allowSelfSigned });
}

function netHint(err) {
  const m = String(err?.message || '').toLowerCase();
  if (m.includes('self signed')) return 'TLS failed: self-signed certificate.';
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

/* ============================ GraphQL core ============================ */

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
      // stop only on non-schema problems; keep trying on “cannot query field …”
      if (!e._validation) break;
    }
  }
  throw lastErr;
}

/* ========================= adaptive query sets ========================== */

const Q_INFO_ARRAY = [
  // Newer schema
  `query {
    info { os { distro release uptime } }
    array { state capacity { used total } }
  }`,
  // Older names
  `query {
    system { hostname osVersion uptime }
    array { status capacity { used total } }
  }`,
  // “free/total” variant
  `query {
    info { os { distro release uptime } }
    array { state capacity { free total } }
  }`,
  // “size*” variant
  `query {
    info { os { distro release uptime } }
    array { state capacity { sizeUsed sizeTotal } }
  }`
];

const Q_DOCKERS = [
  `query { docker { containers { id names image status state autoStart } } }`,
  `query { docker { list { id name image status state } } }`
];

const Q_VMS = [
  `query { vms { domains { id name state } } }`,
  `query { vms { domain(id:"*") { id name state } } }`
];

const Q_METRICS = [
  `query { metrics { cpu { percentTotal } memory { percentTotal } } }`,
  // Fallback that always exists (we'll treat metrics as N/A)
  `query { info { versions { id } } }`
];

/* ============================== public API ============================== */

/**
 * getHostStatus is now resilient:
 * - Fetches sections in parallel
 * - Any section may fail; we still return others
 * - Returns { ok:true, data, warnings:[] } if at least one succeeded
 */
export async function getHostStatus(baseUrl) {
  const warnings = [];
  const sections = {
    system: null, docker: null, vms: null, metrics: null
  };

  const tasks = {
    infoArray: (async () => {
      const sys = await tryQueries(baseUrl, Q_INFO_ARRAY);

      let hostname='(Unraid)', osVersion='', uptime=null;
      if (sys.info?.os) {
        hostname = sys.info.os.distro || hostname;
        osVersion = sys.info.os.release || osVersion;
        uptime = sys.info.os.uptime ?? uptime;
      } else if (sys.system) {
        hostname = sys.system.hostname || hostname;
        osVersion = sys.system.osVersion || osVersion;
        uptime = sys.system.uptime ?? uptime;
      }

      const arrObj = sys.array || {};
      const arrayStatus = arrObj.state || arrObj.status || '';

      // Capacity variants: used/total | free/total | sizeUsed/sizeTotal
      let used = arrObj.capacity?.used ?? arrObj.capacity?.sizeUsed ?? null;
      let total = arrObj.capacity?.total ?? arrObj.capacity?.sizeTotal ?? null;
      if ((used == null || total == null) && arrObj.capacity?.free != null && arrObj.capacity?.total != null) {
        // compute used from free/total when provided
        used = (arrObj.capacity.total - arrObj.capacity.free);
        total = arrObj.capacity.total;
      }
      const storagePct = (used != null && total) ? Math.round((used / total) * 100) : null;

      sections.system = { hostname, osVersion, uptime, array: { status: arrayStatus, storagePct } };
    })(),

    docker: (async () => {
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
      sections.docker = { running, total: mapped.length };
    })(),

    vms: (async () => {
      try {
        const v = await tryQueries(baseUrl, Q_VMS);
        const domains = v?.vms?.domains || [];
        const running = domains.filter(d => String(d.state).toLowerCase() === 'running').length;
        sections.vms = { running, total: domains.length };
      } catch (e) {
        // VM schema missing on some builds — not a hard error
        warnings.push(`VMs: ${e.message}`);
      }
    })(),

    metrics: (async () => {
      try {
        const m = await tryQueries(baseUrl, Q_METRICS);
        const cpuPct = (m?.metrics?.cpu?.percentTotal != null)
          ? Math.round(m.metrics.cpu.percentTotal) : null;
        const ramPct = (m?.metrics?.memory?.percentTotal != null)
          ? Math.round(m.metrics.memory.percentTotal) : null;
        // storage from system (filled by infoArray if present)
        sections.metrics = { cpuPct, ramPct };
      } catch (e) {
        warnings.push(`Metrics: ${e.message}`);
      }
    })()
  };

  // execute and collect partial failures
  const results = await Promise.allSettled(Object.values(tasks));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const names = Object.keys(tasks);
      warnings.push(`${names[i]}: ${r.reason?.message || String(r.reason)}`);
    }
  });

  // compute storagePct from system if present
  const storagePct = sections.system?.array?.storagePct ?? null;
  if (sections.metrics) sections.metrics.storagePct = storagePct;

  const anySuccess = !!(sections.system || sections.docker || sections.vms || sections.metrics);
  if (!anySuccess) return { ok: false, error: warnings[0] || 'All queries failed' };

  return { ok: true, data: sections, warnings };
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

/* ----------------------- mutations (unchanged) ----------------------- */

async function tryMutations(baseUrl, variants, variablesList) {
  let lastErr;
  for (let i = 0; i < variants.length; i++) {
    try { return await gql(baseUrl, variants[i], variablesList[i] || {}); }
    catch (e) { lastErr = e; if (!e._validation) break; }
  }
  throw lastErr;
}

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

export async function powerAction() {
  throw new Error('System power actions are not available via this Unraid API.');
}
