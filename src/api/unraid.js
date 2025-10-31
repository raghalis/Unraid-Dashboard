// src/api/unraid.js
import fetch from 'node-fetch';
import https from 'https';
import { getToken } from '../store/configStore.js';

const allowSelfSigned = (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true';

// Make an HTTPS agent that ignores self-signed if allowed
const httpsAgent = new https.Agent({
  rejectUnauthorized: !allowSelfSigned
});

// Pick the right agent per-URL (https gets our agent; http gets none)
function agentFor(urlString) {
  const u = new URL(urlString);
  if (u.protocol === 'https:') return httpsAgent;
  if (u.protocol === 'http:') return undefined; // no agent for http
  throw new Error(`Unsupported protocol: ${u.protocol}`);
}

// Single GraphQL helper with crisp errors
async function gqlRequest(baseUrl, query, variables = {}) {
  const token = getToken(baseUrl);
  if (!token) throw new Error(`No API token configured for ${baseUrl}`);

  const endpoint = new URL('/graphql', baseUrl).toString();

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      agent: agentFor(endpoint),
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ query, variables })
    });
  } catch (e) {
    // Network/TLS level error: make it human-readable
    const msg = String(e?.message || e);
    if (msg.includes('self-signed certificate')) {
      throw new Error(`TLS failed (self-signed). Set UNRAID_ALLOW_SELF_SIGNED=true or use a trusted cert. (${endpoint})`);
    }
    if (msg.includes('Protocol "http:" not supported')) {
      throw new Error(`HTTP URL used where HTTPS was expected. Use https://… in Base URL or disable TLS validation if proxied.`);
    }
    throw new Error(`Request to ${endpoint} failed: ${msg}`);
  }

  if (!res.ok) {
    // 401/403 etc — include response text for diagnosis
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from ${endpoint}: ${text || 'no body'}`);
  }

  const json = await res.json().catch(() => ({}));
  if (json.errors && json.errors.length) {
    throw new Error(`GraphQL error(s) from ${endpoint}: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

/* --------- Queries/Mutations (adjust if your schema differs) --------- */
const Q_HOST_STATUS = `
query {
  system {
    hostname
    osVersion
    uptime
    array { status parityStatus }
    docker { running total }
    vms { running total }
  }
}`;
const Q_DOCKER_LIST = `query { docker { containers { id name state image } } }`;
const Q_VM_LIST     = `query { vms    { list       { id name state } } }`;
const M_CONTAINER_ACTION = `mutation($id: ID!, $action: String!) { docker { containerAction(id: $id, action: $action) } }`;
const M_VM_ACTION        = `mutation($id: ID!, $action: String!) { vm { action(id: $id, action: $action) } }`;
const M_POWER_ACTION     = `mutation($action: String!) { system { power(action: $action) } }`;

/* --------------------------------- API --------------------------------- */
export async function getHostStatus(baseUrl) {
  try {
    const data = await gqlRequest(baseUrl, Q_HOST_STATUS);
    return { ok: true, data };
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
export async function containerAction(baseUrl, id, action) {
  return gqlRequest(baseUrl, M_CONTAINER_ACTION, { id, action });
}
export async function vmAction(baseUrl, id, action) {
  return gqlRequest(baseUrl, M_VM_ACTION, { id, action });
}
export async function powerAction(baseUrl, action) {
  return gqlRequest(baseUrl, M_POWER_ACTION, { action }); // "reboot" | "shutdown"
}
