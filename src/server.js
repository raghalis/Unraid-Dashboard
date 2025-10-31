import express from 'express';
import path from 'path';
import fs from 'fs';
import nocache from 'nocache';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  initStore, listHosts, upsertHost, deleteHost,
  setToken, tokensSummary
} from './store/configStore.js';
import {
  getHostStatus, listContainers, listVMs,
  containerAction, vmAction, powerAction
} from './api/unraid.js';
import { sendWol } from './api/wol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/* Optional: allow insecure TLS for self-signed targets */
if ((process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/* ------------------------------- Logging -------------------------------- */
const DATA_DIR = '/app/data';
const LOG_PATH = path.join(DATA_DIR, 'app.log');
fs.mkdirSync(DATA_DIR, { recursive: true });
const ts = () => new Date().toISOString();
const log = (level, msg, ctx={}) => {
  const line = JSON.stringify({ ts: ts(), level, msg, ctx });
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
};
const info = (m,c)=>log('info',m,c);
const warn = (m,c)=>log('warn',m,c);
const error= (m,c)=>log('error',m,c);

/* -------------------------------- Setup --------------------------------- */
initStore();
app.use(express.json({ limit: '1mb' }));
app.use(nocache());

/* ----------------------------- Basic Auth ------------------------------- */
const USER = process.env.BASIC_AUTH_USER || '';
const PASS = process.env.BASIC_AUTH_PASS || '';
app.use(async (req, res, next) => {
  if (!USER || !PASS) return next();
  const { default: auth } = await import('basic-auth');
  const creds = auth(req);
  if (!creds || creds.name !== USER || creds.pass !== PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Restricted"');
    return res.status(401).send('Authentication required.');
  }
  next();
});

/* -------------------------------- CSRF ---------------------------------- */
// Double-submit cookie approach; readable cookie so front-end can echo it in header
const CSRF_NAME = 'ucp_csrf';
const CSRF = process.env.CSRF_SECRET || crypto.randomBytes(16).toString('hex');
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
app.use((req, res, next) => {
  const secure = (req.protocol === 'https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${CSRF_NAME}=${encodeURIComponent(CSRF)}; Path=/; SameSite=Lax${secure}`);
  if (req.method !== 'GET' && req.path.startsWith('/api/')) {
    const cookieTok = getCookie(req, CSRF_NAME);
    const headerTok = req.headers['x-csrf-token'] || '';
    if (!(cookieTok && headerTok && cookieTok === headerTok)) {
      warn('csrf.fail', { path: req.path, hasCookie: !!cookieTok, hasHeader: !!headerTok });
      return res.status(403).json({ ok:false, error:'Bad CSRF', message:'Security check failed. Refresh the page and try again.' });
    }
  }
  next();
});

/* ------------------------------ Static UI ------------------------------- */
app.use('/', express.static(path.join(__dirname, 'web')));

/* ---------------------------- Helpers (HTTP) ---------------------------- */
const OK  = (res, payload)=>res.json(Object.assign({ ok:true }, payload||{}));
const FAIL= (res, status, message, details)=>res.status(status).json({ ok:false, error:message, message, details });

/* --------------------------------- API ---------------------------------- */
// Dashboard cards
app.get('/api/servers', async (_req, res) => {
  const hosts = listHosts();
  const out = await Promise.all(hosts.map(async h => {
    const st = await getHostStatus(h.baseUrl);
    return { name: h.name, baseUrl: h.baseUrl, mac: h.mac,
             status: st.ok ? st.data : null, error: st.ok ? null : st.error };
  }));
  info('servers.list', { count: out.length });
  OK(res, out);
});

// Containers
app.get('/api/host/docker', async (req, res) => {
  const base = String(req.query.base || '');
  try { const items = await listContainers(base); OK(res, items); }
  catch (e) { error('docker.list', { base, err: String(e) }); FAIL(res, 502, 'Failed to list containers. See logs for details.'); }
});
app.post('/api/host/docker/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try { await containerAction(base, id, action); OK(res); }
  catch (e) { error('docker.action', { base, id, action, err: String(e) }); FAIL(res, 502, `Container ${action} failed: ${e.message}`); }
});

// VMs
app.get('/api/host/vms', async (req, res) => {
  const base = String(req.query.base || '');
  try { const items = await listVMs(base); OK(res, items); }
  catch (e) { error('vms.list', { base, err: String(e) }); FAIL(res, 502, 'Failed to list VMs. See logs for details.'); }
});
app.post('/api/host/vm/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try { await vmAction(base, id, action); OK(res); }
  catch (e) { error('vm.action', { base, id, action, err: String(e) }); FAIL(res, 502, `VM ${action} failed: ${e.message}`); }
});

// Power/WOL
app.post('/api/host', async (req, res) => {
  const base = String(req.query.base || '');
  const kind = String(req.query.action || '');
  const { action } = req.body || {};
  const host = listHosts().find(h => h.baseUrl === base);
  if (!host) return FAIL(res, 404, 'Unknown host. Check Base URL.');
  try {
    if (kind === 'power') {
      if (action === 'wake') { await sendWol(host.mac, process.env.WOL_BROADCAST || '255.255.255.255', process.env.WOL_INTERFACE || 'eth0'); info('power.wake', { base, mac: host.mac }); return OK(res); }
      // API doesn’t expose system power in this schema:
      const msg = 'Shutdown/Reboot are not available via API in this schema (WOL only).';
      warn('power.unsupported', { base }); return FAIL(res, 400, msg);
    }
    return FAIL(res, 400, 'Unsupported action.');
  } catch (e) {
    error('power.error', { base, action, err: String(e) });
    FAIL(res, 502, `Power action failed: ${e.message}`);
  }
});

// Settings
app.get('/api/settings/hosts', (_req,res) => {
  const hosts = listHosts(); const tokens = tokensSummary();
  OK(res, hosts.map(h => ({ ...h, tokenSet: !!tokens[h.baseUrl] })));
});
app.post('/api/settings/host', (req,res) => {
  try { const saved = upsertHost(req.body || {}); OK(res, { host: { ...saved, tokenSet: false } }); info('host.upsert', { base: saved.baseUrl }); }
  catch (e) { FAIL(res, 400, e.message || 'Invalid host data.'); }
});
app.delete('/api/settings/host', (req,res) => {
  try { deleteHost(String(req.query.base || '')); OK(res); }
  catch { FAIL(res, 400, 'Failed to delete host.'); }
});
app.post('/api/settings/token', (req,res) => {
  const { baseUrl, token } = req.body || {};
  try { setToken(baseUrl, token); OK(res); info('token.set', { base: baseUrl }); }
  catch (e) { FAIL(res, 400, e.message || 'Failed to save token.'); }
});
app.get('/api/settings/test', async (req,res) => {
  const base = String(req.query.base || '');
  const r = await getHostStatus(base);
  if (!r.ok) { warn('settings.test.failed', { base, allowSelfSigned: (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false'), err: r.error }); return FAIL(res, 502, r.error); }
  OK(res, { system: r.data?.system || null });
});

// Settings UI
app.get('/settings', (_req,res)=>res.sendFile(path.join(__dirname,'web','settings.html')));

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { info('server.start', { port: PORT }); console.log(`Unraid Dashboard listening on :${PORT}`); });
