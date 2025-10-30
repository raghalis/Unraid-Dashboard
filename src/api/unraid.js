import fetch from 'node-fetch';
import fs from 'fs';
import https from 'https';

const tokensPath = '/run/secrets/unraid_tokens.json';
let TOKEN_MAP = {};
if (fs.existsSync(tokensPath)) {
  TOKEN_MAP = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
}

const allowSelfSigned = (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true';
const httpsAgent = new https.Agent({ rejectUnauthorized: !allowSelfSigned });

/**
 * Minimal Unraid API adapter
 * - Prefers GraphQL at /graphql (Unraid 7+)
 * - Falls back to a few “classic” endpoints via WebGUI where possible
 * Note: Endpoints may vary by Unraid version; adjust as needed.
 */

async function gql(baseUrl, query, variables = {}) {
  const token = TOKEN_MAP[baseUrl];
  if (!token) throw new Error(`No token for ${baseUrl}`);
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    agent: httpsAgent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GQL ${baseUrl} ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

/** Example GraphQL snippets (adjust if your schema differs) */
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
}
`;

const Q_DOCKER_LIST = `
query {
  docker {
    containers {
      id name state image
    }
  }
}
`;

const Q_VM_LIST = `
query {
  vms {
    list { id name state }
  }
}
`;

/** Mutations (adjust to your schema names) */
const M_CONTAINER_ACTION = `
mutation($id: ID!, $action: String!) {
  docker { containerAction(id: $id, action: $action) }
}
`;

const M_VM_ACTION = `
mutation($id: ID!, $action: String!) {
  vm { action(id: $id, action: $action) }
}
`;

const M_POWER_ACTION = `
mutation($action: String!) {
  system { power(action: $action) }
}
`;

export async function getHostStatus(baseUrl) {
  try {
    const data = await gql(baseUrl, Q_HOST_STATUS);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function listContainers(baseUrl) {
  return gql(baseUrl, Q_DOCKER_LIST).then(d => d.docker.containers);
}

export async function listVMs(baseUrl) {
  const d = await gql(baseUrl, Q_VM_LIST);
  return d.vms.list;
}

export async function containerAction(baseUrl, id, action) {
  return gql(baseUrl, M_CONTAINER_ACTION, { id, action });
}

export async function vmAction(baseUrl, id, action) {
  return gql(baseUrl, M_VM_ACTION, { id, action });
}

export async function powerAction(baseUrl, action) {
  // action: "reboot" | "shutdown"
  return gql(baseUrl, M_POWER_ACTION, { action });
}
