import express from 'express';
import path from 'path';
import fs from 'fs';
import nocache from 'nocache';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  initStore, listHosts, upsertHost, deleteHost,
  setToken, tokensSummary, getAppSettings, setAppSettings
} from './store/configStore.js';
import {
  getHostStatus, listContainers, listVMs,
  containerAction, vmAction, powerAction
} from './api/unraid.js';
import { sendWol } from './api/wol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/* ------------------------------- Logging -------------------------------- */
const DATA_DIR = '/app/data';
const LOG_PATH = path.join(DATA_DIR, 'app.log');
fs.mkdirSync(DATA_DIR, { recursive: true });
const levels = { error: 0, warn: 1, info: 2, debug: 3 };
function now(){ return new Date().toISOString(); }
function shouldLog(level){
  const { logLevel } = getAppSettings();
  return (levels[level] ?? 2) <= (levels[logLevel] ?? 2);
}
function log(level, msg, ctx={}) {
  if (!shouldLog(level)) return;
  const line = JSON.stringify({ ts: now(), level, msg, ctx });
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}
const info=(m,c)=>log('info',m,c); const warn=(m,c)=>log('warn',m,c); const error=(m,c)=>log('error',m,c); const debug=(m,c)=>log('debug',m,c);

/* -------------------------------- Setup --------------------------------- */
initStore();
app.use(express.json({ limit: '1mb' }));
app.use(nocache());

/* ----------------------------- HTTP Trace ------------------------------- */
app.use((req,res,next)=>{
  const { debugHttp } = getAppSettings();
  if (debugHttp) {
    const t0 = Date.now();
    res.on('finish', () => info('http', { method:req.method, url:req.originalUrl, status:res.statusCode, ms:Date.now()-t0 }));
  }
  next();
});

/* ------------------------------ Health/Ver ------------------------------ */
app.get('/health', (_req,res)=>res.status(200).type('text/plain').send('ok'));
app.get('/version', (_req,res)=>{
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || version; } catch {}
  res.json({ version });
});

/* ------------------------------ Static UI ------------------------------- */
app.use('/', express.static(path.join(__dirname, 'web')));

/* ---------------------------- Helpers (HTTP) ---------------------------- */
const OK  = (res, payload) => Array.isArray(payload) ? res.json(payload) : res.json(Object.assign({ ok:true }, payload || {}));
const FAIL= (res, status, message, details)=>res.status(status).json({ ok:false, error:message, message, details });

/* --------------------------------- API ---------------------------------- */
// Dashboard cards
app.get('/api/servers', async (_req, res) => {
  const hosts = listHosts();
  const out = await Promise.all(hosts.map(async h => {
    const st = await getHostStatus(h.baseUrl);
    return {
      name: h.name, baseUrl: h.baseUrl, mac: h.mac,
      status: st.ok ? st.data : null, error: st.ok ? null : st.error
    };
  }));
  OK(res, out);
});

/* Containers / VMs (same as before) */
app.get('/api/host/docker', async (req, res) => {
  const base = String(req.query.base || '');
  try { const items = await listContainers(base); OK(res, items); }
  catch (e) { error('docker.list', { base, err: String(e) }); FAIL(res, 502, 'Failed to list containers.'); }
});
app.post('/api/host/docker/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try { await containerAction(base, id, action); OK(res, {}); }
  catch (e) { error('docker.action', { base, id, action, err: String(e) }); FAIL(res, 502, `Container ${action} failed: ${e.message}`); }
});

app.get('/api/host/vms', async (req, res) => {
  const base = String(req.query.base || '');
  try { const items = await listVMs(base); OK(res, items); }
  catch (e) { error('vms.list', { base, err: String(e) }); FAIL(res, 502, 'Failed to list VMs.'); }
});
app.post('/api/host/vm/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try { await vmAction(base, id, action); OK(res, {}); }
  catch (e) { error('vm.action', { base, id, action, err: String(e) }); FAIL(res, 502, `VM ${action} failed: ${e.message}`); }
});

/* Power/WOL (unchanged) */
app.post('/api/host', async (req, res) => {
  const base = String(req.query.base || '');
  const kind = String(req.query.action || '');
  const { action } = req.body || {};
  const host = listHosts().find(h => h.baseUrl === base);
  if (!host) return FAIL(res, 404, 'Unknown host.');
  try {
    if (kind === 'power') {
      if (action === 'wake') {
        await sendWol(host.mac, process.env.WOL_BROADCAST || '255.255.255.255', process.env.WOL_INTERFACE || 'eth0');
        info('power.wake', { base, mac: host.mac }); return OK(res, {});
      }
      return FAIL(res, 400, 'Shutdown/Reboot unsupported via API.');
    }
    return FAIL(res, 400, 'Unsupported action.');
  } catch (e) { error('power.error', { base, action, err: String(e) }); FAIL(res, 502, `Power action failed: ${e.message}`); }
});

/* ----------------------------- Settings API ----------------------------- */
app.get('/api/settings/hosts', (_req,res) => {
  const hosts = listHosts();
  const tokens = tokensSummary();
  const arr = hosts.map(h => ({ ...h, tokenSet: !!tokens[h.baseUrl] }));
  OK(res, arr);
});

/* Transactional save: validate token then persist host & token */
app.post('/api/settings/host', async (req,res) => {
  const { name, baseUrl, mac, token, oldBaseUrl } = req.body || {};
  try {
    if (!name || !baseUrl || !mac || !token) throw new Error('Missing fields.');
    // store token temporarily to validate
    setToken(baseUrl, token);
    const test = await getHostStatus(baseUrl);
    if (!test.ok) throw new Error(test.error || 'Validation failed.');

    // upsert host
    const saved = upsertHost({ name, baseUrl, mac });

    // if editing and base changed, remove old
    if (oldBaseUrl && oldBaseUrl !== baseUrl) {
      try { deleteHost(oldBaseUrl); } catch {}
    }

    info('host.upsert', { base: saved.baseUrl });
    OK(res, { host: { ...saved, tokenSet: true } });
  } catch (e) {
    FAIL(res, 400, e.message || 'Invalid host data.');
  }
});

app.delete('/api/settings/host', (req,res) => {
  try { deleteHost(String(req.query.base || '')); OK(res, {}); }
  catch { FAIL(res, 400, 'Failed to delete host.'); }
});

/* Token endpoint for explicit updates if desired */
app.post('/api/settings/token', (req,res) => {
  const { baseUrl, token } = req.body || {};
  try { setToken(baseUrl, token); info('token.set', { base: baseUrl }); OK(res, {}); }
  catch (e) { FAIL(res, 400, e.message || 'Failed to save token.'); }
});

/* Connection test (used by per-row Test) */
app.get('/api/settings/test', async (req,res) => {
  const base = String(req.query.base || '');
  const r = await getHostStatus(base);
  if (!r.ok) { return FAIL(res, 502, r.error); }
  OK(res, { system: r.data?.system || null });
});

/* -------- App-level settings moved from Docker template into UI -------- */
app.get('/api/app', (_req,res)=>OK(res, { settings: getAppSettings() }));
app.post('/api/app', (req,res)=>{
  const { debugHttp, logLevel, allowSelfSigned } = req.body || {};
  const saved = setAppSettings({
    ...(typeof debugHttp === 'boolean' ? { debugHttp } : {}),
    ...(logLevel ? { logLevel } : {}),
    ...(typeof allowSelfSigned === 'boolean' ? { allowSelfSigned } : {})
  });
  info('app.settings', saved);
  OK(res, { settings: saved });
});

/* ------------------------------ Routes/UI ------------------------------- */
app.get('/settings', (_req,res)=>res.sendFile(path.join(__dirname,'web','settings.html')));

/* ------------------------------- Start ---------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { info('server.start', { port: PORT, clientDir: '/app/src/web', version: (()=>{try{return JSON.parse(fs.readFileSync(path.join(__dirname,'..','package.json'),'utf8')).version}catch{return '0.0.0'}})() }); console.log(`Unraid Dashboard listening on :${PORT}`); });
