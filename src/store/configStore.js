import fs from 'fs';
import path from 'path';

const DATA_DIR = '/app/data';
const HOSTS_PATH = path.join(DATA_DIR, 'hosts.json');
const TOKENS_PATH = path.join(DATA_DIR, 'tokens.json');
const APP_PATH = path.join(DATA_DIR, 'app.json');

const defaultsApp = {
  debugHttp: false,
  logLevel: 'info',     // 'error' | 'warn' | 'info' | 'debug'
  allowSelfSigned: (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true'
};

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  ensureDir();
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

/* ------------------------------ Lifecycle ------------------------------ */
export function initStore() {
  ensureDir();
  if (!fs.existsSync(HOSTS_PATH)) writeJson(HOSTS_PATH, []);
  if (!fs.existsSync(TOKENS_PATH)) writeJson(TOKENS_PATH, {});
  if (!fs.existsSync(APP_PATH)) writeJson(APP_PATH, defaultsApp);
}

/* ------------------------------- Hosts --------------------------------- */
export function listHosts() { return readJson(HOSTS_PATH, []); }

export function upsertHost(h) {
  const { name='', baseUrl='', mac='' } = h || {};
  if (!name || !baseUrl || !mac) throw new Error('Missing required fields.');
  const rows = listHosts();
  const idx = rows.findIndex(r => r.baseUrl === baseUrl);
  const row = { name, baseUrl, mac };
  if (idx >= 0) rows[idx] = row; else rows.push(row);
  writeJson(HOSTS_PATH, rows);
  return row;
}

export function deleteHost(baseUrl) {
  const rows = listHosts().filter(r => r.baseUrl !== baseUrl);
  writeJson(HOSTS_PATH, rows);
}

/* ------------------------------- Tokens -------------------------------- */
export function setToken(baseUrl, token) {
  const map = readJson(TOKENS_PATH, {});
  map[baseUrl] = token || '';
  writeJson(TOKENS_PATH, map);
}
export function getToken(baseUrl) { return readJson(TOKENS_PATH, {})[baseUrl] || ''; }
export function tokensSummary() {
  const map = readJson(TOKENS_PATH, {});
  return map;
}

/* ----------------------------- App Settings ---------------------------- */
export function getAppSettings() {
  const saved = readJson(APP_PATH, defaultsApp);
  return { ...defaultsApp, ...saved };
}
export function setAppSettings(patch={}) {
  const cur = getAppSettings();
  const next = { ...cur, ...patch };
  writeJson(APP_PATH, next);
  return next;
}
