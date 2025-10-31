import express from 'express';
import path from 'path';
import fs from 'fs';
import nocache from 'nocache';
import crypto from 'crypto';
import https from 'https';
import fetch from 'node-fetch';
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

/* ------------------------------- Config ---------------------------------- */
const DATA_DIR = '/app/data';
const LOG_PATH = path.join(DATA_DIR, 'app.log');
fs.mkdirSync(DATA_DIR, { recursive: true });

const ENV = (k, d='') => (process.env[k] ?? d);
const ALLOW_SELF_SIGNED = (ENV('UNRAID_ALLOW_SELF_SIGNED','false') === 'true');
const LOG_LEVEL = (ENV('LOG_LEVEL','info')); // debug|info|warn|error
const BASIC_USER = ENV('BASIC_AUTH_USER','');
const BASIC_PASS = ENV('BASIC_AUTH_PASS','');

if (ALLOW_SELF_SIGNED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const httpsAgent = new https.Agent({ rejectUnauthorized: !ALLOW_SELF_SIGNED });

const ts = () => new Date().toISOString();
function writeLog(obj) {
  const line = JSON.stringify(obj);
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}
function log(level, msg, ctx={}) {
  const order = { debug:0, info:1, warn:2, error:3 };
  if (order[level] < order[LOG_LEVEL]) return;
  writeLog({ ts: ts(), level, msg, ctx });
}
const debug = (m,c)=>log('debug',m,c);
const info  = (m,c)=>log('info', m,c);
const warn  = (m,c)=>log('warn', m,c);
const error = (m,c)=>log('error',m,c);

/* ------------------------------- Boot ------------------------------------ */
initStore();
app.use(express.json({ limit: '1mb' }));
app.use(nocache());

/* --------------------------- Lightweight HTTP log ------------------------ */
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    log('info', 'http', { method: req.method, url: req.originalUrl, status: res.statusCode, ms });
  });
  next();
});

/* --------------------------- Health (no auth/csrf) ----------------------- */
app.get('/health', (_req, res) => res.status(200).type('text/plain').send('ok'));

/* ----------------------------- Basic Auth -------------------------------- */
// Protect everything except /health and static assets needed to render the login prompt.
if (BASIC_USER && BASIC_PASS) {
  app.use(async (req, res, next) => {
    if (req.path === '/health') return next();
    const { default: auth } = await import('basic-auth');
    const creds = auth(req);
    if (!creds || creds.name !== BASIC_USER || creds.pass !== BASIC_PASS) {
      res.set('WWW-Authenticate', 'Basic realm="Restricted"');
      return res.status(401).send('Authentication required.');
    }
    next();
  });
}

/* -------------------------------- CSRF ---------------------------------- */
const CSRF_NAME = 'ucp_csrf';
const CSRF = process.env.CSRF_SECRET || crypto.randomBytes(16).toString('hex');
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
app.use((req, res, next) => {
  // set cookie for browser
  const secure = (req.protocol === 'https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${CSRF_NAME}=${encodeURIComponent(CSRF)}; Path=/; SameSite=Lax${secure}`);
  // enforce for mutating API calls
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
// Serve dashboard by default (index.html). Settings lives at /settings.
app.use('/', express.static(path.join(__dirname, 'web')));

/* ----------------------------- Helpers ---------------------------------- */
const OK   = (res, payload) => Array.isArray(payload)
  ? res.json(payload)
  : res.json(Object.assign({ ok:true }, payload || {}));
const FAIL = (res, status, message, details) =>
  res.status(status).json({ ok:false, error:message, message, details });

/* ---------------------- Unraid quick test helper ------------------------- */
async function testUnraid(baseUrl, token) {
  // minimal query present across API versions
  const query = `query { vars { name version } }`;
  const endpoint = new URL('/graphql', baseUrl).toString();
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      agent: (new URL(baseUrl).protocol === 'https:' ? httpsAgent : undefined),
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'x-api-key': token || ''
      },
      body: JSON.stringify({ query })
    });
  } catch (e) {
    throw new Error(`Network error contacting ${endpoint}: ${e.message}`);
  }
  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw:text }; }

  if (!resp.ok) {
    const msg = (json?.errors && json.errors[0]?.message) || `HTTP ${resp.status}`;
    throw new Error(`HTTP ${resp.status} from ${endpoint}: ${msg}`);
  }
  if (json?.errors?.length) {
    throw new Error(json.errors.map(e=>e.message).join('; '));
  }
  return json?.data?.vars || null;
}

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
  try {
    const items = await listContainers(base);
    OK(res, items);
  } catch (e) {
    error('docker.list', { base, err: String(e) });
    FAIL(res, 502, 'Failed to list containers. See logs for details.');
  }
});
app.post('/api/host/docker/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try {
    await containerAction(base, id, action);
    OK(res, {});
  } catch (e) {
    error('docker.action', { base, id, action, err: String(e) });
    FAIL(res, 502, `Container ${action} failed: ${e.message}`);
  }
});

// VMs
app.get('/api/host/vms', async (req, res) => {
  const base = String(req.query.base || '');
  try {
    const items = await listVMs(base);
    OK(res, items);
  } catch (e) {
    error('vms.list', { base, err: String(e) });
    FAIL(res, 502, 'Failed to list VMs. See logs for details.');
  }
});
app.post('/api/host/vm/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try {
    await vmAction(base, id, action);
    OK(res, {});
  } catch (e) {
    error('vm.action', { base, id, action, err: String(e) });
    FAIL(res, 502, `VM ${action} failed: ${e.message}`);
  }
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
      if (action === 'wake') {
        await sendWol(host.mac, ENV('WOL_BROADCAST','255.255.255.255'), ENV('WOL_INTERFACE','eth0'));
        info('power.wake', { base, mac: host.mac });
        return OK(res, {});
      }
      const msg = 'Shutdown/Reboot are not available via API in this schema (WOL only).';
      warn('power.unsupported', { base });
      return FAIL(res, 400, msg);
    }
    return FAIL(res, 400, 'Unsupported action.');
  } catch (e) {
    error('power.error', { base, action, err: String(e) });
    FAIL(res, 502, `Power action failed: ${e.message}`);
  }
});

/* ------------------------------ Settings -------------------------------- */
app.get('/api/settings/hosts', (_req,res) => {
  const hosts = listHosts();
  const tokens = tokensSummary();
  const arr = hosts.map(h => ({ ...h, tokenSet: !!tokens[h.baseUrl] }));
  OK(res, arr);
});

// Save host (optionally validate before persisting)
app.post('/api/settings/host', async (req,res) => {
  const { name='', baseUrl='', mac='', token='' } = req.body || {};
  const doValidate = (String(req.query.validate || '').toLowerCase() === 'true');

  try {
    if (doValidate) {
      info('settings.validate.begin', { base: baseUrl, name });
      await testUnraid(baseUrl, token);
      info('settings.validate.ok', { base: baseUrl, name });
    }

    const saved = upsertHost({ name, baseUrl, mac });
    if (token) { setToken(baseUrl, token); }
    info('host.upsert', { base: saved.baseUrl, validated: !!doValidate });
    return OK(res, { host: { ...saved, tokenSet: !!token } });
  } catch (e) {
    warn('settings.save.failed', { base: baseUrl, err: String(e) });
    return FAIL(res, 422, e.message || 'Failed to save: validation error.');
  }
});

// Convenience alias: save + test in one call
app.post('/api/settings/host/save-and-test', async (req,res) => {
  req.query.validate = 'true';
  return app._router.handle(req, res, () => {}); // reuse handler above
});

app.delete('/api/settings/host', (req,res) => {
  try { deleteHost(String(req.query.base || '')); OK(res, {}); }
  catch (e) { FAIL(res, 400, e.message || 'Failed to delete host.'); }
});

app.post('/api/settings/token', (req,res) => {
  const { baseUrl, token } = req.body || {};
  try { setToken(baseUrl, token); info('token.set', { base: baseUrl }); OK(res, {}); }
  catch (e) { FAIL(res, 400, e.message || 'Failed to save token.'); }
});

app.get('/api/settings/test', async (req,res) => {
  const base = String(req.query.base || '');
  try {
    const r = await getHostStatus(base);
    if (!r.ok) {
      warn('settings.test.failed', { base, err: r.error, allowSelfSigned: ENV('UNRAID_ALLOW_SELF_SIGNED','false') });
      return FAIL(res, 502, r.error);
    }
    OK(res, { system: r.data?.system || null });
  } catch (e) {
    warn('settings.test.threw', { base, err: String(e) });
    FAIL(res, 502, e.message || 'Failed to contact Unraid.');
  }
});

/* ------------------------------ Settings UI ------------------------------ */
app.get('/settings', (_req,res)=>res.sendFile(path.join(__dirname,'web','settings.html')));

/* -------------------------------- Start ---------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  info('server.start', { port: PORT, clientDir: path.join(__dirname,'web'), version: ENV('APP_VERSION','0.0.0') });
  console.log(`Unraid Dashboard listening on :${PORT}`);
});
