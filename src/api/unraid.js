import fetch from 'node-fetch';
import https from 'https';
import { getToken } from '../store/configStore.js';

const allowSelfSigned = (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true';
const httpsAgent = new https.Agent({ rejectUnauthorized: !allowSelfSigned });

// single GraphQL helper
async function gqlRequest(baseUrl, query, variables = {}) {
  const token = getToken(baseUrl);
  if (!token) throw new Error(`No token for ${baseUrl}`);
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    agent: httpsAgent,
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`GQL ${baseUrl} ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(`GQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// Queries / Mutations (adjust to your Unraid GraphQL schema if needed)
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
const Q_DOCKER_LIST = `
query {
  docker { containers { id name state image } }
}`;
const Q_VM_LIST = `
query {
  vms { list { id name state } }
}`;
const M_CONTAINER_ACTION = `
mutation($id: ID!, $action: String!) {
  docker { containerAction(id: $id, action: $action) }
}`;
const M_VM_ACTION = `
mutation($id: ID!, $action: String!) {
  vm { action(id: $id, action: $action) }
}`;
const M_POWER_ACTION = `
mutation($action: String!) {
  system { power(action: $action) }
}`;

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
  return gqlRequest(baseUrl, M_POWER_ACTION, { action }); // reboot | shutdown
}
