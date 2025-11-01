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

/* =============================== logging =============================== */

const DATA_DIR = '/app/data';
const LOG_PATH = path.join(DATA_DIR, 'app.log');
fs.mkdirSync(DATA_DIR, { recursive: true });

const levels = { error: 0, warn: 1, info: 2, debug: 3 };
function tzNow() {
  // Local timezone of the container (respects TZ env)
  return new Intl.DateTimeFormat(undefined, {
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    hour12:false
  }).format(new Date());
}
function shouldLog(level){
  const { logLevel } = getAppSettings();
  return (levels[level] ?? 2) <= (levels[logLevel] ?? 2);
}
function line(level, msg, ctx){
  const ctxStr = ctx ? ` | ${ctx}` : '';
  return `[${tzNow()}] ${level.toUpperCase()}  ${msg}${ctxStr}`;
}
function log(level, msg, ctxObj) {
  if (!shouldLog(level)) return;
  const ctx = ctxObj
    ? Object.entries(ctxObj).map(([k,v]) => `${k}=${typeof v==='string'?v:JSON.stringify(v)}`).join(' ')
    : '';
  const l = line(level, msg, ctx);
  console.log(l);
  try { fs.appendFileSync(LOG_PATH, l + '\n'); } catch {}
}
const info=(m,c)=>log('info',m,c);
const warn=(m,c)=>log('warn',m,c);
const error=(m,c)=>log('error',m,c);
const debug=(m,c)=>log('debug',m,c);

/* ================================ setup ================================ */

initStore();
app.use(express.json({ limit: '1mb' }));
app.use(nocache());

/* HTTP access log (pretty) */
app.use((req,res,next)=>{
  const { debugHttp } = getAppSettings();
  if (!debugHttp) return next();
  const t0 = Date.now();
  res.on('finish', () => info('HTTP', { method:req.method, url:req.originalUrl, status:res.statusCode, ms:Date.now()-t0 }));
  next();
});

/* health & version */
app.get('/health', (_req,res)=>res.status(200).type('text/plain').send('ok'));
app.get('/version', (_req,res)=>{
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || version; } catch {}
  res.json({ version });
});

/* static */
app.use('/', express.static(path.join(__dirname, 'web')));

/* helpers */
const OK  = (res, payload) => Array.isArray(payload) ? res.json(payload) : res.json(Object.assign({ ok:true }, payload || {}));
const FAIL= (res, status, message, details)=>res.status(status).json({ ok:false, error:message, message, details });

/* ================================ API ================================= */

/* Dashboard: resilient status with warnings surfaced */
app.get('/api/servers', async (_req, res) => {
  const hosts = listHosts();
  const out = await Promise.all(hosts.map(async h => {
    const st = await getHostStatus(h.baseUrl);
    if (!st.ok) {
      warn('status.fail', { base:h.baseUrl, error:st.error });
      return { name:h.name, baseUrl:h.baseUrl, mac:h.mac, status:null, error:st.error };
    }
    if (st.warnings?.length) {
      warn('status.partial', { base:h.baseUrl, warnings:st.warnings.join(' | ') });
    }
    return { name:h.name, baseUrl:h.baseUrl, mac:h.mac, status:st.data, error:null, warnings:st.warnings || [] };
  }));
  OK(res, out);
});

/* Containers */
app.get('/api/host/docker', async (req, res) => {
  const base = String(req.query.base || '');
  try { const items = await listContainers(base); OK(res, items); }
  catch (e) { error('docker.list', { base, err:String(e) }); FAIL(res, 502, 'Failed to list containers.'); }
});
app.post('/api/host/docker/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try { await containerAction(base, id, action); OK(res, {}); }
  catch (e) { error('docker.action', { base, id, action, err:String(e) }); FAIL(res, 502, `Container ${action} failed: ${e.message}`); }
});

/* VMs */
app.get('/api/host/vms', async (req, res) => {
  const base = String(req.query.base || '');
  try { const items = await listVMs(base); OK(res, items); }
  catch (e) { error('vms.list', { base, err:String(e) }); FAIL(res, 502, 'Failed to list VMs.'); }
});
app.post('/api/host/vm/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try { await vmAction(base, id, action); OK(res, {}); }
  catch (e) { error('vm.action', { base, id, action, err:String(e) }); FAIL(res, 502, `VM ${action} failed: ${e.message}`); }
});

/* Power/WOL */
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
        info('power.wake', { base, mac:host.mac }); return OK(res, {});
      }
      return FAIL(res, 400, 'Shutdown/Reboot unsupported via API.');
    }
    return FAIL(res, 400, 'Unsupported action.');
  } catch (e) { error('power.error', { base, action, err:String(e) }); FAIL(res, 502, `Power action failed: ${e.message}`); }
});

/* ----------------------------- Settings API ----------------------------- */

app.get('/api/settings/hosts', (_req,res) => {
  const hosts = listHosts();
  const tokens = tokensSummary();
  const arr = hosts.map(h => ({ ...h, tokenSet: !!tokens[h.baseUrl] }));
  OK(res, arr);
});

/**
 * Transactional host save:
 * - we persist the token temporarily to test
 * - host is saved only if at least one status section succeeds
 */
app.post('/api/settings/host', async (req,res) => {
  const { name, baseUrl, mac, token, oldBaseUrl } = req.body || {};
  try {
    if (!name || !baseUrl || !mac || !token) throw new Error('Missing fields.');
    setToken(baseUrl, token);

    const test = await getHostStatus(baseUrl);
    if (!test.ok) throw new Error(test.error || 'Validation failed.');

    const saved = upsertHost({ name, baseUrl, mac });

    if (oldBaseUrl && oldBaseUrl !== baseUrl) {
      try { deleteHost(oldBaseUrl); } catch {}
    }

    if (test.warnings?.length) {
      warn('host.validate.partial', { base: baseUrl, warnings: test.warnings.join(' | ') });
    } else {
      info('host.validate.ok', { base: baseUrl });
    }

    OK(res, { host: { ...saved, tokenSet: true }, warnings: test.warnings || [] });
  } catch (e) {
    error('host.save.fail', { base: baseUrl, err: String(e) });
    FAIL(res, 400, e.message || 'Invalid host data.');
  }
});

app.delete('/api/settings/host', (req,res) => {
  try { deleteHost(String(req.query.base || '')); OK(res, {}); }
  catch { FAIL(res, 400, 'Failed to delete host.'); }
});

app.post('/api/settings/token', (req,res) => {
  const { baseUrl, token } = req.body || {};
  try { setToken(baseUrl, token); info('token.set', { base: baseUrl }); OK(res, {}); }
  catch (e) { FAIL(res, 400, e.message || 'Failed to save token.'); }
});

app.get('/api/settings/test', async (req,res) => {
  const base = String(req.query.base || '');
  const r = await getHostStatus(base);
  if (!r.ok) { warn('settings.test.fail', { base, err:r.error }); return FAIL(res, 502, r.error); }
  if (r.warnings?.length) warn('settings.test.partial', { base, warnings:r.warnings.join(' | ') });
  OK(res, { system: r.data?.system || null, warnings: r.warnings || [] });
});

/* --------- App-level settings (tweak at runtime; no redeploy) ---------- */
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

/* pages */
app.get('/settings', (_req,res)=>res.sendFile(path.join(__dirname,'web','settings.html')));

/* start */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname,'..','package.json'),'utf8')).version; } catch {}
  info('server.start', { port: PORT, version, clientDir: '/app/src/web' });
  console.log(`Unraid Dashboard listening on :${PORT}`);
});
