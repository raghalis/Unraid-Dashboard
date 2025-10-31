import fetch from 'node-fetch';
import https from 'https';
import { getToken } from '../store/configStore.js';

const allowSelfSigned = (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true';

// HTTPS agent honoring self-signed toggle
const httpsAgent = new https.Agent({ rejectUnauthorized: !allowSelfSigned });

// Choose agent by protocol
function agentFor(urlString) {
  const u = new URL(urlString);
  if (u.protocol === 'https:') return httpsAgent;
  if (u.protocol === 'http:') return undefined;
  throw new Error(`Unsupported protocol: ${u.protocol}`);
}

// common fetch wrapper with clean errors
async function doFetch(endpoint, opts) {
  try {
    const res = await fetch(endpoint, { ...opts, agent: agentFor(endpoint) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} from ${endpoint}: ${text || 'no body'}`);
    }
    return res;
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('self-signed certificate')) {
      throw new Error(`TLS failed (self-signed). Enable UNRAID_ALLOW_SELF_SIGNED=true or use a trusted cert. (${endpoint})`);
    }
    if (msg.includes('Protocol "http:" not supported')) {
      throw new Error(`HTTP URL used where HTTPS expected. Use https://… or adjust reverse proxy.`);
    }
    throw new Error(`Request to ${endpoint} failed: ${msg}`);
  }
}

// Single GraphQL helper
async function gqlRequest(baseUrl, query, variables = {}) {
  const token = getToken(baseUrl);
  if (!token) throw new Error(`No API token configured for ${baseUrl}`);
  const endpoint = new URL('/graphql', baseUrl).toString();

  const res = await doFetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json().catch(() => ({}));
  if (json.errors && json.errors.length) {
    // bubble up schema errors un-mangled
    throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

/* ---------- Adaptive: try several shapes (schemas vary) ---------- */
// small utility to try queries in order and return first that works
async function tryQueries(baseUrl, queries) {
  let lastErr;
  for (const q of queries) {
    try { return await gqlRequest(baseUrl, q); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// candidates for “host info”
const Q_SYSTEM_VARIANTS = [
  // v1 (what we tried first)
  `query { system { hostname osVersion uptime array { status parityStatus } docker { running total } vms { running total } } }`,
  // some builds expose server/info instead of system
  `query { server { hostname version uptime } }`,
  `query { info { hostname version uptime } }`,
  // last resort: at least prove auth works by listing counts
  `query { docker { containers { id } } vms { list { id } } }`
];

// standard lists
const Q_DOCKER_LIST = `query { docker { containers { id name state image } } }`;
const Q_VM_LIST     = `query { vms { list { id name state } } }`;

/* ------------------------------ API ------------------------------ */
export async function getHostStatus(baseUrl) {
  try {
    const data = await tryQueries(baseUrl, Q_SYSTEM_VARIANTS);
    // normalize to a friendly shape
    const out = { system: {}, docker: {}, vms: {} };

    // from system/server/info variants
    if (data.system || data.server || data.info) {
      const s = data.system || data.server || data.info;
      out.system.hostname   = s.hostname  || '(unknown)';
      out.system.osVersion  = s.osVersion || s.version || '(unknown)';
      out.system.uptime     = s.uptime    || null;
      out.system.array      = s.array     || null;
      out.docker.running    = s.docker?.running ?? undefined;
      out.docker.total      = s.docker?.total   ?? undefined;
      out.vms.running       = s.vms?.running    ?? undefined;
      out.vms.total         = s.vms?.total      ?? undefined;
    }

    // If counts missing, compute via lists
    if (out.docker.running === undefined || out.docker.total === undefined) {
      try {
        const d = await gqlRequest(baseUrl, Q_DOCKER_LIST);
        const arr = d?.docker?.containers || [];
        out.docker.total = arr.length;
        out.docker.running = arr.filter(c => String(c.state).toLowerCase() === 'running').length;
      } catch {}
    }
    if (out.vms.running === undefined || out.vms.total === undefined) {
      try {
        const d = await gqlRequest(baseUrl, Q_VM_LIST);
        const arr = d?.vms?.list || [];
        out.vms.total = arr.length;
        out.vms.running = arr.filter(v => String(v.state).toLowerCase() === 'running').length;
      } catch {}
    }

    return { ok: true, data: { system: out.system, docker: out.docker, vms: out.vms } };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

export async function listContainers(baseUrl) {
  const d = await gqlRequest(baseUrl, Q_DOCKER_LIST);
  return d.docker.containers;
}
export async function listVMs(baseUrl) {
  const d = await gqlRequest(baseUrl, Q_VM_LIST);
  return d.vms.list;
}

// Mutations — keep names generic; adjust if your schema differs
const M_CONTAINER_ACTION = `mutation($id: ID!, $action: String!) { docker { containerAction(id: $id, action: $action) } }`;
const M_VM_ACTION        = `mutation($id: ID!, $action: String!) { vm { action(id: $id, action: $action) } }`;
const M_POWER_ACTION     = `mutation($action: String!) { system { power(action: $action) } }`;

export async function containerAction(baseUrl, id, action) {
  return gqlRequest(baseUrl, M_CONTAINER_ACTION, { id, action });
}
export async function vmAction(baseUrl, id, action) {
  return gqlRequest(baseUrl, M_VM_ACTION, { id, action });
}
export async function powerAction(baseUrl, action) {
  return gqlRequest(baseUrl, M_POWER_ACTION, { action }); // "reboot" | "shutdown"
}
