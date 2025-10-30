import fs from 'fs';
import path from 'path';

const DATA_DIR = '/app/data';
const HOSTS_PATH = path.join(DATA_DIR, 'hosts.json');
const TOKENS_PATH = path.join(DATA_DIR, 'tokens.json');

// legacy locations (for one-time import)
const LEGACY_HOSTS = '/app/config/hosts.json';
const LEGACY_TOKENS = '/run/secrets/unraid_tokens.json';

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// crude validators
function isMac(s) { return /^[0-9A-Fa-f:]{17}$/.test(s); }
function isUrl(s) { try { new URL(s); return true; } catch { return false; } }

export function initStore() {
  ensureDir();
  // migrate once if data files not present
  if (!fs.existsSync(HOSTS_PATH) && fs.existsSync(LEGACY_HOSTS)) {
    const hosts = readJson(LEGACY_HOSTS, []);
    writeJson(HOSTS_PATH, hosts);
  }
  if (!fs.existsSync(TOKENS_PATH) && fs.existsSync(LEGACY_TOKENS)) {
    const tokens = readJson(LEGACY_TOKENS, {});
    writeJson(TOKENS_PATH, tokens);
  }
  // ensure files exist
  if (!fs.existsSync(HOSTS_PATH)) writeJson(HOSTS_PATH, []);
  if (!fs.existsSync(TOKENS_PATH)) writeJson(TOKENS_PATH, {});
}

export function listHosts() {
  return readJson(HOSTS_PATH, []);
}

export function upsertHost(host) {
  const hosts = listHosts();
  const h = {
    name: String(host.name || '').trim(),
    baseUrl: String(host.baseUrl || '').trim(),
    mac: String(host.mac || '').trim().toUpperCase()
  };
  if (!h.name || !isUrl(h.baseUrl) || !isMac(h.mac)) {
    throw new Error('Invalid host: need name, valid URL, and MAC (AA:BB:CC:DD:EE:FF).');
  }
  const i = hosts.findIndex(x => x.baseUrl === h.baseUrl);
  if (i >= 0) hosts[i] = h; else hosts.push(h);
  writeJson(HOSTS_PATH, hosts);
  return h;
}

export function deleteHost(baseUrl) {
  const hosts = listHosts().filter(h => h.baseUrl !== baseUrl);
  writeJson(HOSTS_PATH, hosts);
  // also remove token
  const tokens = readJson(TOKENS_PATH, {});
  if (tokens[baseUrl]) {
    delete tokens[baseUrl];
    writeJson(TOKENS_PATH, tokens);
  }
}

export function setToken(baseUrl, token) {
  if (!isUrl(baseUrl) || !token) throw new Error('Invalid token request.');
  const tokens = readJson(TOKENS_PATH, {});
  tokens[baseUrl] = token;
  writeJson(TOKENS_PATH, tokens);
}

export function getToken(baseUrl) {
  const tokens = readJson(TOKENS_PATH, {});
  return tokens[baseUrl] || '';
}

export function tokensSummary() {
  // for UI mask: { baseUrl: true/false }
  const tokens = readJson(TOKENS_PATH, {});
  const res = {};
  Object.keys(tokens).forEach(k => res[k] = !!tokens[k]);
  return res;
}
