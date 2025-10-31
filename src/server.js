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
  containerAction, vmAction
} from './api/unraid.js';
import { sendWol } from './api/wol.js';
import { monitorEventLoopDelay, performance } from 'perf_hooks';

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

const LEVELS = { error:0, warn:1, info:2, debug:3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const HTTP_LOG  = (process.env.HTTP_LOG  || 'false').toLowerCase() === 'true';
const ts = () => new Date().toISOString();

function rotateIfNeeded() {
  const max = Number(process.env.DIAG_ROTATE_BYTES || 5 * 1024 * 1024);
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size >= max) {
      const stamp = ts().replaceAll(':','-');
      const dest = `${LOG_PATH}.${stamp}.1`;
      try { fs.renameSync(LOG_PATH, dest); } catch {}
    }
  } catch {}
}

function baseLog(level, msg, ctx = {}) {
  if ((LEVELS[level] ?? 99) > (LEVELS[LOG_LEVEL] ?? 2)) return;
  const line = JSON.stringify({ ts: ts(), level, msg, ctx });
  console.log(line);
  try { rotateIfNeeded(); fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}
const info  = (m,c)=>baseLog('info', m,c);
const warn  = (m,c)=>baseLog('warn', m,c);
const error = (m,c)=>baseLog('error',m,c);
const debug = (m,c)=>baseLog('debug',m,c);

/* Crash guards */
process.on('unhandledRejection', (reason) => error('unhandledRejection', { reason: String(reason) }));
process.on('uncaughtException', (err) => error('uncaughtException', { err: String(err), stack: err?.stack }));

/* -------------------------------- Setup --------------------------------- */
initStore();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(nocache());

/* HTTP request logs (gated) */
if (HTTP_LOG) {
  app.use((req, res, next) => {
    const t0 = performance.now();
    res.on('finish', () => {
      info('http', { method: req.method, url: req.originalUrl || req.url, status: res.statusCode, ms: Math.round(performance.now() - t0) });
    });
    next();
  });
}

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
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, 'web');
app.use('/', express.static(CLIENT_DIR));
app.get('/settings', (_req,res)=>res.sendFile(path.join(CLIENT_DIR, 'settings.html')));

/* ---------------------------- Helpers (HTTP) ---------------------------- */
const OK  = (res, payload) => Array.isArray(payload)
  ? res.json(payload)
  : res.json(Object.assign({ ok:true }, payload || {}));
const FAIL= (res, status, message, details)=>res.status(status).json({ ok:false, error:message, message, details });

/* --------------------------------- API ---------------------------------- */
// Health / debug
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Version: env first, then file, then 'dev'
app.get('/api/version', (_req, res) => {
  const envVer = (process.env.APP_VERSION || '').trim();
  let fileVer = '';
  try { fileVer = fs.readFileSync('/app/version.txt', 'utf8').trim(); } catch {}
  const version = envVer || fileVer || 'dev';
  OK(res, { version });
});

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
  try { await containerAction(base, id, action); OK(res, {}); }
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
  try { await vmAction(base, id, action); OK(res, {}); }
  catch (e) { error('vm.action', { base, id, action, err: String(e) }); FAIL(res, 502, `VM ${action} failed: ${e.message}`); }
});

// Power/WOL (WOL only)
app.post('/api/host', async (req, res) => {
  const base = String(req.query.base || '');
  const kind = String(req.query.action || '');
  const { action } = req.body || {};
  const host = listHosts().find(h => h.baseUrl === base);
  if (!host) return FAIL(res, 404, 'Unknown host. Check Base URL.');
  try {
    if (kind === 'power') {
      if (action === 'wake') {
        await sendWol(host.mac, process.env.WOL_BROADCAST || '255.255.255.255', process.env.WOL_INTERFACE || 'eth0');
        info('power.wake', { base, mac: host.mac });
        return OK(res, {});
      }
      const msg = 'Shutdown/Reboot are not available via this API (WOL only).';
      warn('power.unsupported', { base }); return FAIL(res, 400, msg);
    }
    return FAIL(res, 400, 'Unsupported action.');
  } catch (e) {
    error('power.error', { base, action, err: String(e) });
    FAIL(res, 502, `Power action failed: ${e.message}`);
  }
});

/* ========================= SPA fallback (client routes) ====================== */
app.get(/^(?!\/api\/).+/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  const indexPath = path.join(CLIENT_DIR, 'index.html');
  fs.access(indexPath, fs.constants.R_OK, (err) => {
    if (err) { debug('spa.index.missing', { indexPath }); return next(); }
    res.sendFile(indexPath, (sendErr) => {
      if (sendErr) { error('spa.index.send.error', { err: String(sendErr) }); next(sendErr); }
    });
  });
});

/* ================================ Error handler ============================= */
app.use((err, req, res, _next) => {
  error('request.error', {
    url: req.originalUrl || req.url,
    method: req.method,
    err: String(err),
    stack: err?.stack,
  });
  const status = Number(err?.status) || 500;
  res.status(status).json({ ok:false, error: err?.message || 'Internal Server Error' });
});

/* ================================== Start =================================== */
const PORT = process.env.PORT || 8080;

/* Event loop lag monitor (kept minimal here) */
const el = monitorEventLoopDelay({ resolution: 10 }); el.enable();
setInterval(() => { el.reset(); }, 1000).unref();

app.listen(PORT, () => {
  info('server.start', { port: PORT, clientDir: CLIENT_DIR, version: process.env.APP_VERSION || '(env unset)' });
  console.log(`Unraid Dashboard listening on :${PORT}`);
});
