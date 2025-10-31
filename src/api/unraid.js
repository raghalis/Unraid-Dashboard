// src/api/unraid.js
import fetch from 'node-fetch';
import https from 'node:https';

const logCtx = (logger, msg, ctx = {}, level = 'info') =>
  logger[level]({ ts: new Date().toISOString(), msg, ctx });

function makeAgent(allowSelfSigned) {
  return allowSelfSigned
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;
}

// Map low-level/network errors to human messages
function humanizeNetErr(err) {
  const m = String(err && err.message || '').toLowerCase();
  if (m.includes('self signed certificate')) return 'TLS failed: self-signed certificate (enable self-signed in container settings or use a valid cert)';
  if (m.includes('unable to verify') || m.includes('certificate')) return 'TLS failed: certificate verification';
  if (m.includes('getaddrinfo') || m.includes('dns')) return 'DNS error contacting the Unraid host';
  if (m.includes('connect econnrefused')) return 'Connection refused by the Unraid host';
  if (m.includes('fetch failed') || m.includes('network')) return 'Network error contacting the Unraid host';
  if (m.includes('timeout')) return 'Timeout contacting the Unraid host';
  return null;
}

export async function gql(logger, { baseUrl, apiKey, query, variables = {}, allowSelfSigned = false, originForCors }) {
  const url = `${baseUrl.replace(/\/+$/,'')}/graphql`;
  const agent = makeAgent(allowSelfSigned);

  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json'
  };
  if (apiKey) headers['x-api-key'] = apiKey;       // per Unraid docs
  if (originForCors) headers['origin'] = originForCors;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      agent
    });
  } catch (err) {
    const human = humanizeNetErr(err);
    const msg = human || `Network error: ${err.message || err}`;
    logCtx(logger, 'unraid.gql.network_error', { url, err: String(err) }, 'warn');
    throw new Error(msg);
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    logCtx(logger, 'unraid.gql.bad_json', { url, status: res.status, body: text.slice(0, 3000) }, 'warn');
    throw new Error(`Unexpected response from Unraid API (status ${res.status}).`);
  }

  if (!res.ok) {
    // GraphQL-compatible error body
    const errMsg = (json.errors && json.errors[0] && json.errors[0].message) || `HTTP ${res.status}`;
    logCtx(logger, 'unraid.gql.http_error', { url, status: res.status, errors: json.errors }, 'warn');
    throw new Error(`HTTP ${res.status} from ${url}: ${errMsg}`);
  }

  if (json.errors && json.errors.length) {
    logCtx(logger, 'unraid.gql.graphql_error', { url, errors: json.errors }, 'warn');
    // surface the first helpful error
    throw new Error(json.errors.map(e => e.message).join('; '));
  }

  return json.data;
}

// --- Minimal queries that match the public docs schema (safe for "Test") ---
// See: https://docs.unraid.net/API/how-to-use-the-api/  (info / array / dockerContainers)
export const TEST_QUERY = `
  query {
    info {
      os { distro release uptime }
      cpu { brand cores threads }
    }
    array { state }
    dockerContainers { id names state status }
  }
`;

// You can extend these with guarded/feature-detected queries later.
