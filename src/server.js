import express from 'express';
import path from 'path';
import fs from 'fs';
import nocache from 'nocache';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { sendWol } from './api/wol.js';
import {
  getHostStatus, listContainers, listVMs,
  containerAction, vmAction, powerAction
} from './api/unraid.js';

import {
  initStore, listHosts, upsertHost, deleteHost,
  setToken, tokensSummary
} from './store/configStore.js';

// If self-signed is allowed, also relax Node's global TLS check (helps
// if a dependency doesn't pass our agent through correctly)
if ((process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/* ------------------------- basic logger ------------------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = '/app/data';
const LOG_PATH = path.join(DATA_DIR, 'app.log');
function ensureDir(p){ try{ fs.mkdirSync(p,{recursive:true}); }catch{} }
ensureDir(DATA_DIR);

const DEBUG = (process.env.DEBUG || 'true') === 'true';
function ts(){ return new Date().toISOString(); }
function log(level, msg, ctx){
  const line = JSON.stringify({ ts: ts(), level, msg, ctx: ctx||{} });
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}
function info(msg, ctx){ log('info', msg, ctx); }
function warn(msg, ctx){ log('warn', msg, ctx); }
function error(msg, ctx){ log('error', msg, ctx); }

/* ------------------------- express app ------------------------- */
const app = express();
app.use(express.json());
app.use(nocache());

/* ------------------------- Basic Auth -------------------------- */
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

/* --------------------------- CSRF ------------------------------ */
/**
 * Double-submit cookie: we set a NON-HttpOnly cookie so the browser
 * can read it and mirror to X-CSRF-Token. (My earlier HttpOnly cookie
 * made that impossible—hence your “Bad CSRF”.)
 */
const CSRF_NAME = 'ucp_csrf';
const CSRF = process.env.CSRF_SECRET || crypto.randomBytes(16).toString('hex');

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

app.use((req, res, next) => {
  const secure = (req.protocol === 'https') ? '; Secure' : '';
  // NOTE: no HttpOnly, by design (so client JS can read it)
  res.setHeader('Set-Cookie', `${CSRF_NAME}=${encodeURIComponent(CSRF)}; Path=/; SameSite=Lax${secure}`);

  if (req.method !== 'GET' && req.path.startsWith('/api/')) {
    const cookieTok = getCookie(req, CSRF_NAME);
    const headerTok = req.headers['x-csrf-token'] || '';
    const ok = cookieTok && headerTok && cookieTok === headerTok;
    if (!ok) {
      warn('CSRF validation failed', {
        path: req.path,
        hasCookie: !!cookieTok,
        hasHeader: !!headerTok
      });
      return res.status(403).json({
        error: 'Bad CSRF',
        message: 'Security check failed. Please refresh the page and try again.'
      });
    }
  }
  next();
});

/* ------------------------- Store init -------------------------- */
initStore();

/* ------------------------- Static UI --------------------------- */
app.use('/', express.static(path.join(__dirname, 'web')));

/* --------------------- response helpers ------------------------ */
function ok(res, payload){ return res.json(Object.assign({ ok: true }, payload||{})); }
function fail(res, status, message, details){
  const body = { ok:false, error: message, message, details: details || undefined };
  return res.status(status).json(body);
}

/* ------------------------- API routes -------------------------- */
app.get('/api/servers', async (req, res) => {
  const hosts = listHosts();
  const result = await Promise.all(hosts.map(async h => {
    const status = await getHostStatus(h.baseUrl);
    return {
      name: h.name, baseUrl: h.baseUrl, mac: h.mac,
      status: status.ok ? status.data : null,
      error: status.ok ? null : status.error
    };
  }));
  info('servers.list', { count: result.length });
  ok(res, result);
});

app.get('/api/host/docker', async (req, res) => {
  const base = String(req.query.base || '');
  try {
    const items = await listContainers(base);
    info('docker.list', { base, count: items.length });
    ok(res, items);
  } catch (e) {
    error('docker.list.error', { base, err: String(e) });
    fail(res, 500, 'Failed to list containers. See logs for details.');
  }
});

app.post('/api/host/docker/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action: act } = req.body || {};
  try {
    await containerAction(base, id, act);
    info('docker.action', { base, id, action: act });
    ok(res);
  } catch (e) {
    error('docker.action.error', { base, id, action: act, err: String(e) });
    fail(res, 500, `Container action "${act}" failed. See logs for details.`);
  }
});

app.get('/api/host/vms', async (req, res) => {
  const base = String(req.query.base || '');
  try {
    const items = await listVMs(base);
    info('vm.list', { base, count: items.length });
    ok(res, items);
  } catch (e) {
    error('vm.list.error', { base, err: String(e) });
    fail(res, 500, 'Failed to list VMs. See logs for details.');
  }
});

app.post('/api/host/vm/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action: act } = req.body || {};
  try {
    await vmAction(base, id, act);
    info('vm.action', { base, id, action: act });
    ok(res);
  } catch (e) {
    error('vm.action.error', { base, id, action: act, err: String(e) });
    fail(res, 500, `VM action "${act}" failed. See logs for details.`);
  }
});

app.post('/api/host', async (req, res) => {
  const kind = String(req.query.action || '');
  const base = String(req.query.base || '');
  const { action: act } = req.body || {};
  const host = listHosts().find(h => h.baseUrl === base);
  if (!host) return fail(res, 404, 'Unknown host. Check Base URL.');

  try {
    if (kind === 'power') {
      if (act === 'wake') {
        await sendWol(host.mac, process.env.WOL_BROADCAST || '255.255.255.255', process.env.WOL_INTERFACE || 'eth0');
        info('power.wake', { base, mac: host.mac });
        return ok(res);
      }
      if (act === 'reboot' || act === 'shutdown') {
        await powerAction(base, act);
        info('power.action', { base, action: act });
        return ok(res);
      }
    }
    return fail(res, 400, 'Unsupported power action.');
  } catch (e) {
    error('power.action.error', { base, action: act, err: String(e) });
    fail(res, 500, `Power action "${act}" failed. See logs for details.`);
  }
});

/* ----------------------- Settings API -------------------------- */
app.get('/api/settings/hosts', (req, res) => {
  const hosts = listHosts();
  const tokens = tokensSummary();
  info('settings.hosts.list', { count: hosts.length });
  ok(res, hosts.map(h => ({ ...h, tokenSet: !!tokens[h.baseUrl] })));
});

app.post('/api/settings/host', (req, res) => {
  try {
    const saved = upsertHost(req.body || {});
    const tokenSet = !!tokensSummary()[saved.baseUrl];
    info('settings.hosts.upsert', { base: saved.baseUrl, name: saved.name });
    ok(res, { host: { ...saved, tokenSet } });
  } catch (e) {
    warn('settings.hosts.upsert.error', { body: req.body, err: String(e) });
    fail(res, 400, e.message || 'Invalid host data.');
  }
});

app.delete('/api/settings/host', (req, res) => {
  const base = String(req.query.base || '');
  try {
    deleteHost(base);
    info('settings.hosts.delete', { base });
    ok(res);
  } catch (e) {
    warn('settings.hosts.delete.error', { base, err: String(e) });
    fail(res, 400, 'Failed to delete host.');
  }
});

app.post('/api/settings/token', (req, res) => {
  const { baseUrl, token } = req.body || {};
  try {
    setToken(baseUrl, token);
    info('settings.token.set', { base: baseUrl, tokenSet: !!token });
    ok(res);
  } catch (e) {
    warn('settings.token.set.error', { base: baseUrl, err: String(e) });
    fail(res, 400, 'Failed to save token. Check Base URL and token format.');
  }
});

app.get('/api/settings/test', async (req, res) => {
  const base = String(req.query.base || '');
  try {
    const r = await getHostStatus(base);
    if (!r.ok) {
      warn('settings.test.failed', {
        base,
        allowSelfSigned: (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false'),
        err: r.error
      });
      return fail(res, 502, r.error.includes('self-signed')
        ? 'TLS failed: self-signed certificate. Enable UNRAID_ALLOW_SELF_SIGNED or use a trusted cert.'
        : r.error);
    }
    info('settings.test.ok', { base });
    ok(res, { system: r.data?.system || null });
  } catch (e) {
    error('settings.test.error', { base, err: String(e) });
    fail(res, 500, 'Test failed due to an internal error. See logs for details.');
  }
});

/* ----------------------- Settings Page ------------------------- */
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'settings.html'));
});

/* -------------------------- Start ------------------------------ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  info('server.start', { port: PORT });
  console.log(`Unraid Dashboard listening on :${PORT}`);
});
