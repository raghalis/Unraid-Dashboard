import fs from 'fs';
import path from 'path';

const DATA_DIR = '/app/data';
const HOSTS_PATH = path.join(DATA_DIR, 'hosts.json');
const TOKENS_PATH = path.join(DATA_DIR, 'tokens.json');

// legacy/seed (imported once if data missing)
const LEGACY_HOSTS = '/app/config/hosts.json';
const LEGACY_TOKENS = '/run/secrets/unraid_tokens.json';
const EXAMPLE_HOSTS = '/app/examples/config.hosts.json';
const EXAMPLE_TOKENS = '/app/examples/secrets.tokens.json';

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function isMac(s) { return /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(s); }
function isUrl(s) { try { new URL(s); return true; } catch { return false; } }

export function initStore() {
  ensureDir();
  if (!fs.existsSync(HOSTS_PATH)) {
    const seed = fs.existsSync(LEGACY_HOSTS) ? LEGACY_HOSTS :
                 fs.existsSync(EXAMPLE_HOSTS) ? EXAMPLE_HOSTS : null;
    writeJson(HOSTS_PATH, seed ? readJson(seed, []) : []);
  }
  if (!fs.existsSync(TOKENS_PATH)) {
    const seed = fs.existsSync(LEGACY_TOKENS) ? LEGACY_TOKENS :
                 fs.existsSync(EXAMPLE_TOKENS) ? EXAMPLE_TOKENS : null;
    writeJson(TOKENS_PATH, seed ? readJson(seed, {}) : {});
  }
}

export function listHosts() { return readJson(HOSTS_PATH, []); }

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
  writeJson(HOSTS_PATH, listHosts().filter(h => h.baseUrl !== baseUrl));
  const tokens = readJson(TOKENS_PATH, {});
  if (tokens[baseUrl]) { delete tokens[baseUrl]; writeJson(TOKENS_PATH, tokens); }
}

export function setToken(baseUrl, token) {
  if (!isUrl(baseUrl) || !token) throw new Error('Invalid token request.');
  const tokens = readJson(TOKENS_PATH, {});
  tokens[baseUrl] = token;
  writeJson(TOKENS_PATH, tokens);
}

export function getToken(baseUrl) { return readJson(TOKENS_PATH, {})[baseUrl] || ''; }

export function tokensSummary() {
  const tokens = readJson(TOKENS_PATH, {}); const res = {};
  Object.keys(tokens).forEach(k => { res[k] = !!tokens[k]; });
  return res;
}
