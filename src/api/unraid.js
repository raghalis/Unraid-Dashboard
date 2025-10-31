import fetch from 'node-fetch';
import https from 'https';
import { getToken } from '../store/configStore.js';

/** Honor self-signed toggle */
const allowSelfSigned = (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true';
const httpsAgent = new https.Agent({ rejectUnauthorized: !allowSelfSigned });

function agentFor(urlString) {
  const u = new URL(urlString);
  if (u.protocol === 'https:') return httpsAgent;
  if (u.protocol === 'http:') return undefined;
  throw new Error(`Unsupported protocol: ${u.protocol}`);
}

function humanizeNetErr(e) {
  const m = (e?.message || '').toLowerCase();
  if (m.includes('self signed')) return 'TLS failed: self-signed certificate. Enable UNRAID_ALLOW_SELF_SIGNED=true or use a trusted cert.';
  if (m.includes('unauthorized') || m.includes('401')) return 'Unauthorized. Check the Unraid API key.';
  if (m.includes('econnrefused')) return 'Connection refused by the Unraid host.';
  if (m.includes('getaddrinfo') || m.includes('dns')) return 'DNS error contacting the Unraid host.';
  if (m.includes('timeout')) return 'Timeout contacting the Unraid host.';
  return null;
}

async function doFetchJSON(endpoint, opts) {
  let res;
  try {
    res = await fetch(endpoint, { ...opts, agent: agentFor(endpoint) });
  } catch (e) {
    throw new Error(humanizeNetErr(e) || `Network error: ${e.message || e}`);
  }
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

/** GraphQL POST with x-api-key */
async function gqlRequest(baseUrl, query, variables = {}) {
  const token = getToken(baseUrl);
  if (!token) throw new Error(`No API token configured for ${baseUrl}`);
  const endpoint = new URL('/graphql', baseUrl).toString();

  const { ok, status, json } = await doFetchJSON(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'x-api-key': token   // per Unraid API docs
    },
    body: JSON.stringify({ query, variables })
  });

  if (!ok) {
    const msg = (json?.errors && json.errors[0]?.message) || `HTTP ${status}`;
    throw new Error(`HTTP ${status} from ${endpoint}: ${msg}`);
  }
  if (json?.errors?.length) {
    throw new Error(json.errors.map(e => e.message).join('; '));
  }
  return json.data;
}

/** Queries that match Unraid docs */
const Q_TEST = `
  query {
    info { os { distro release uptime } cpu { brand cores threads } }
    array { state }
    dockerContainers { id names state status autoStart }
  }
`;

export async function getHostStatus(baseUrl) {
  try {
    const data = await gqlRequest(baseUrl, Q_TEST);

    // Normalize to what the UI expects
    const sys = {
      hostname: data?.info?.os?.distro || '(Unraid)',
      osVersion: data?.info?.os?.release || '',
      uptime: data?.info?.os?.uptime ?? null,
      array: { status: data?.array?.state || '' }
    };

    // derive counts
    const conts = data?.dockerContainers || [];
    const running = conts.filter(c => String(c.state).toLowerCase() === 'running').length;
    const docker = { running, total: conts.length };

    // VMs: not in the public sample schema; return n/a for now
    const vms = { running: 0, total: 0 };

    return { ok: true, data: { system: sys, docker, vms } };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

export async function listContainers(baseUrl) {
  const data = await gqlRequest(baseUrl, `
    query { dockerContainers { id names state status autoStart } }
  `);
  // Map to fit UI (name/image fields)
  return (data?.dockerContainers || []).map(c => ({
    id: c.id,
    name: (Array.isArray(c.names) && c.names[0]) || c.id,
    image: c.status || '',
    state: c.state
  }));
}

// VM support varies by version; for now return empty list gracefully.
export async function listVMs(_baseUrl) {
  return [];
}

// Mutations: these are placeholders; wire up once schema for actions is confirmed.
export async function containerAction(_baseUrl, _id, _action) {
  throw new Error('Container actions not implemented for this Unraid API schema yet.');
}
export async function vmAction(_baseUrl, _id, _action) {
  throw new Error('VM actions not implemented for this Unraid API schema yet.');
}
export async function powerAction(_baseUrl, _action) {
  throw new Error('Power actions not implemented for this Unraid API schema yet.');
}
