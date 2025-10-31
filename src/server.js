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

/* ====================== TLS: allow self-signed (opt-in) ====================== */
if ((process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/* ============================== Logging setup =============================== */
const DATA_DIR = '/app/data';
const LOG_PATH = path.join(DATA_DIR, 'app.log');
fs.mkdirSync(DATA_DIR, { recursive: true });

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase(); // error|warn|info|debug
const HTTP_LOG  = (process.env.HTTP_LOG  || 'false').toLowerCase() === 'true';

const ts = () => new Date().toISOString();
function shouldLog(level) {
  return (LEVELS[level] ?? 1) <= (LEVELS[LOG_LEVEL] ?? 2);
}
function baseLog(level, msg, ctx = {}) {
  if (!shouldLog(level)) return;
  const line = JSON.stringify({ ts: ts(), level, msg, ctx });
  // Console
  console.log(line);
  // File
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}
const info  = (m, c) => baseLog('info',  m, c);
const warn  = (m, c) => baseLog('warn',  m, c);
const error = (m, c) => baseLog('error', m, c);
const debug = (m, c) => baseLog('debug', m, c);

/* =============================== Crash guards =============================== */
process.on('unhandledRejection', (reason) => {
  error('unhandledRejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  error('uncaughtException', { err: String(err), stack: err?.stack });
});

/* ================================= Setup ==================================== */
initStore();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(nocache());

/* ================================ HTTP log ================================= */
if (HTTP_LOG) {
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      info('http', {
        method: req.method,
        url: req.originalUrl || req.url,
        status: res.statusCode,
        ms: Date.now() - t0,
      });
    });
    next();
  });
}

/* ================================ Basic Auth ================================ */
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

/* ================================== CSRF ==================================== */
const CSRF_NAME = 'ucp_csrf';
const CSRF = process.env.CSRF_SECRET || crypto.randomBytes(16).toString('hex');
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
app.use((req, res, next) => {
  const secure = (req.protocol === 'https') ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${CSRF_NAME}=${encodeURIComponent(CSRF)}; Path=/; SameSite=Lax${secure}`
  );
  if (req.method !== 'GET' && req.path.startsWith('/api/')) {
    const cookieTok = getCookie(req, CSRF_NAME);
    const headerTok = req.headers['x-csrf-token'] || '';
    if (!(cookieTok && headerTok && cookieTok === headerTok)) {
      warn('csrf.fail', { path: req.path, hasCookie: !!cookieTok, hasHeader: !!headerTok });
      return res.status(403).json({
        ok: false,
        error: 'Bad CSRF',
        message: 'Security check failed. Refresh the page and try again.'
      });
    }
  }
  next();
});

/* =============================== Static / UI ================================ */
// Allow overriding where the built client lives
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, 'web');

// Serve static assets
app.use('/', express.static(CLIENT_DIR));

// Settings landing (keep your explicit route)
app.get('/settings', (_req, res) =>
  res.sendFile(path.join(CLIENT_DIR, 'settings.html'))
);

/* ============================== Helpers (HTTP) ============================== */
// Arrays are returned raw; objects get { ok:true, ...payload }
const OK = (res, payload) =>
  Array.isArray(payload) ? res.json(payload) : res.json(Object.assign({ ok: true }, payload || {}));
const FAIL = (res, status, message, details) =>
  res.status(status).json({ ok: false, error: message, message, details });

/* ================================== API ===================================== */
// Health (for container checks)
app.get('/health', (_req, res) => res.status(200).send('ok'));

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
        await sendWol(
          host.mac,
          process.env.WOL_BROADCAST || '255.255.255.255',
          process.env.WOL_INTERFACE || 'eth0'
        );
        info('power.wake', { base, mac: host.mac });
        return OK(res, {});
      }
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
app.get('/api/settings/hosts', (_req, res) => {
  const hosts = listHosts();
  const tokens = tokensSummary();
  const arr = hosts.map(h => ({ ...h, tokenSet: !!tokens[h.baseUrl] }));
  OK(res, arr);
});
app.post('/api/settings/host', (req, res) => {
  try {
    const saved = upsertHost(req.body || {});
    info('host.upsert', { base: saved.baseUrl });
    OK(res, { host: { ...saved, tokenSet: false } });
  } catch (e) { FAIL(res, 400, e.message || 'Invalid host data.'); }
});
app.delete('/api/settings/host', (req, res) => {
  try { deleteHost(String(req.query.base || '')); OK(res, {}); }
  catch { FAIL(res, 400, 'Failed to delete host.'); }
});
app.post('/api/settings/token', (req, res) => {
  const { baseUrl, token } = req.body || {};
  try { setToken(baseUrl, token); info('token.set', { base: baseUrl }); OK(res, {}); }
  catch (e) { FAIL(res, 400, e.message || 'Failed to save token.'); }
});
app.get('/api/settings/test', async (req, res) => {
  const base = String(req.query.base || '');
  const r = await getHostStatus(base);
  if (!r.ok) {
    warn('settings.test.failed', { base, allowSelfSigned: (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false'), err: r.error });
    return FAIL(res, 502, r.error);
  }
  OK(res, { system: r.data?.system || null });
});

/* ========================= SPA fallback (fixes "crash") ====================== */
/* Any non-API GET route should serve index.html so client-side routing works. */
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
  res.status(status).json({ ok: false, error: err?.message || 'Internal Server Error' });
});

/* ================================== Start =================================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  info('server.start', { port: PORT });
  console.log(`Unraid Dashboard listening on :${PORT}`);
});
