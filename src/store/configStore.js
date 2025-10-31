import fs from 'fs';
import path from 'path';

const DATA_DIR = '/app/data';
const HOSTS_PATH = path.join(DATA_DIR, 'hosts.json');
const TOKENS_PATH = path.join(DATA_DIR, 'tokens.json');

let hosts = [];
let tokens = {}; // { baseUrl: token }

export function initStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(HOSTS_PATH)) {
    try { hosts = JSON.parse(fs.readFileSync(HOSTS_PATH, 'utf8')); }
    catch { hosts = []; }
  }
  if (fs.existsSync(TOKENS_PATH)) {
    try { tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')); }
    catch { tokens = {}; }
  }
}

function persist() {
  fs.writeFileSync(HOSTS_PATH, JSON.stringify(hosts, null, 2));
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

export function listHosts() { return hosts.slice(); }

export function upsertHost(h) {
  const name = String(h.name || '').trim();
  const baseUrl = String(h.baseUrl || '').trim().replace(/\/+$/,'');
  const mac = String(h.mac || '').trim();

  if (!name) throw new Error('Missing name.');
  if (!/^https?:\/\/[^ ]+$/i.test(baseUrl)) throw new Error('Base URL must start with http:// or https://');
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(mac)) throw new Error('MAC must be AA:BB:CC:DD:EE:FF');

  const i = hosts.findIndex(x => x.baseUrl === baseUrl);
  const obj = { name, baseUrl, mac };
  if (i >= 0) hosts[i] = obj; else hosts.push(obj);
  persist();
  return obj;
}

export function deleteHost(baseUrl) {
  const before = hosts.length;
  hosts = hosts.filter(h => h.baseUrl !== baseUrl);
  if (hosts.length === before) throw new Error('Host not found.');
  persist();
}

export function setToken(baseUrl, token) {
  if (!/^https?:\/\/[^ ]+$/i.test(baseUrl)) throw new Error('Invalid Base URL.');
  if (!String(token || '').trim()) throw new Error('Token is empty.');
  tokens[baseUrl] = token.trim();
  persist();
}
export function getToken(baseUrl) { return tokens[baseUrl]; }
export function tokensSummary() { return { ...tokens }; }
