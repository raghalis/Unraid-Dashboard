import express from 'express';
import path from 'path';
import fs from 'fs';
import nocache from 'nocache';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { monitorEventLoopDelay, performance } from 'perf_hooks';

import {
  initStore, listHosts, upsertHost, deleteHost,
  setToken, tokensSummary
} from './store/configStore.js';
import {
  getHostStatus, listContainers, listVMs,
  containerAction, vmAction
} from './api/unraid.js';
import { sendWol } from './api/wol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/* ====================== TLS: allow self-signed (opt-in) ====================== */
if ((process.env.UNRAID_ALLOW_SELF_SIGNED || 'false').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/* ============================== Diagnostics cfg ============================== */
const DATA_DIR = '/app/data';
const LOG_FILE = path.join(DATA_DIR, 'app.log');
const DIAG_DIR = DATA_DIR;

const LEVELS = { error:0, warn:1, info:2, debug:3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();  // error|warn|info|debug
const HTTP_LOG  = (process.env.HTTP_LOG  || 'false').toLowerCase() === 'true';

const HEARTBEAT_MS   = Number(process.env.DIAG_HEARTBEAT_MS || 15000);
const LAG_SAMPLE_MS  = Number(process.env.DIAG_LAG_SAMPLE_MS || 1000);
const LAG_WARN_MS    = Number(process.env.DIAG_LAG_WARN_MS || 250);     // warn if p95 > 250ms
const LAG_FATAL_MS   = Number(process.env.DIAG_LAG_FATAL_MS || 1000);   // error if max > 1s
const ROTATE_BYTES   = Number(process.env.DIAG_ROTATE_BYTES || 5 * 1024 * 1024); // 5MB
const REPORT_ON_ERR  = (process.env.DIAG_REPORT_ON_ERR || 'true').toLowerCase() === 'true';
const REPORT_ON_SIG  = (process.env.DIAG_REPORT_ON_SIG || 'true').toLowerCase() === 'true';
const CLIENT_DIR     = process.env.CLIENT_DIR || path.join(__dirname, 'web');

/* ================================== Logging ================================= */
fs.mkdirSync(DATA_DIR, { recursive: true });

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size >= ROTATE_BYTES) {
      const ts = new Date().toISOString().replaceAll(':','-');
      const dest = `${LOG_FILE}.${ts}.1`;
      try { fs.renameSync(LOG_FILE, dest); } catch {}
    }
  } catch {}
}

function writableCheck() {
  const testPath = path.join(DATA_DIR, `.writecheck_${Date.now()}.tmp`);
  try {
    fs.writeFileSync(testPath, 'ok');
    fs.unlinkSync(testPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function baseLog(level, msg, ctx = {}) {
  if ((LEVELS[level] ?? 99) > (LEVELS[LOG_LEVEL] ?? 2)) return;
  const rec = { ts: new Date().toISOString(), level, msg, ctx };
  const line = JSON.stringify(rec);
  console.log(line);
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    // If we can’t write, at least shout to console once in a while
    console.error(JSON.stringify({ ts: rec.ts, level:'error', msg:'log.write.fail', ctx:{ err:String(e) }}));
  }
}
const debug = (m,c)=>baseLog('debug',m,c);
const info  = (m,c)=>baseLog('info', m,c);
const warn  = (m,c)=>baseLog('warn', m,c);
const error = (m,c)=>baseLog('error',m,c);

/* =============================== Crash guards =============================== */
if (REPORT_ON_ERR) {
  process.on('unhandledRejection', (reason) => {
    error('unhandledRejection', { reason: String(reason) });
    try { writeDiagReport('unhandledRejection'); } catch {}
  });
  process.on('uncaughtException', (err) => {
    error('uncaughtException', { err: String(err), stack: err?.stack });
    try { writeDiagReport('uncaughtException', err); } catch {}
  });
}

// Node diagnostic report helpers
function writeDiagReport(label, err) {
  try {
    if (!process.report || typeof process.report.writeReport !== 'function') return;
    const p = path.join(DIAG_DIR, `diag-${label}-${Date.now()}.json`);
    process.report.writeReport(p, err);
    info('diag.report.written', { path: p });
  } catch (e) {
    warn('diag.report.fail', { err: String(e) });
  }
}

if (REPORT_ON_SIG) {
  for (const sig of ['SIGTERM','SIGINT','SIGHUP']) {
    process.on(sig, () => {
      info('signal', { sig });
      try { writeDiagReport(`signal-${sig}`); } catch {}
      // graceful shutdown if needed; we keep default behavior (exit)
      process.exit(0);
    });
  }
}

/* ============================== Event loop lag ============================== */
const el = monitorEventLoopDelay({ resolution: 10 });
el.enable();

function lagSnapshot() {
  const mean = Number(el.mean / 1e6).toFixed(2); // ms
  const p50  = Number(el.percentile(50) / 1e6).toFixed(2);
  const p95  = Number(el.percentile(95) / 1e6).toFixed(2);
  const max  = Number(el.max / 1e6).toFixed(2);
  return { mean: +mean, p50:+p50, p95:+p95, max:+max };
}

setInterval(() => {
  const snap = lagSnapshot();
  if (snap.p95 > LAG_WARN_MS) {
    warn('eventloop.lag', snap);
  } else if (LOG_LEVEL === 'debug') {
    debug('eventloop.lag', snap);
  }
  if (snap.max > LAG_FATAL_MS) {
    error('eventloop.lag.severe', snap);
  }
  el.reset();
}, LAG_SAMPLE_MS).unref();

/* =============================== Heartbeat ================================ */
setInterval(() => {
  const wr = writableCheck();
  info('hb', {
    up_s: Math.round(process.uptime()),
    rss_mb: Math.round(process.memoryUsage().rss / (1024*1024)),
    writable: wr.ok ? 'ok' : `ERR: ${wr.error}`
  });
}, HEARTBEAT_MS).unref();

/* ================================= Server ================================= */
initStore();
app.disable('x-powered-by');
app.use(express.json({ limit:'1mb' }));
app.use(nocache());

// HTTP request log (gated)
if (HTTP_LOG) {
  app.use((req, res, next) => {
    const t0 = performance.now();
    res.on('finish', () => {
      info('http', {
        m: req.method,
        u: req.originalUrl || req.url,
        s: res.statusCode,
        ms: Math.round(performance.now() - t0)
      });
    });
    next();
  });
}

/* ================================= Auth =================================== */
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

/* ================================= CSRF =================================== */
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

/* =============================== Static / UI =============================== */
app.use('/', express.static(CLIENT_DIR));
app.get('/settings', (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'settings.html')));

/* ============================== Helpers (HTTP) ============================== */
const OK = (res, payload) => Array.isArray(payload)
  ? res.json(payload)
  : res.json(Object.assign({ ok:true }, payload || {}));
const FAIL = (res, status, message, details) =>
  res.status(status).json({ ok:false, error:message, message, details });

/* ================================== API ===================================== */
// lightweight liveness
app.get('/health', (_req, res) => res.status(200).send('ok'));

// heavyweight on-demand diag
app.get('/debug/diag', (_req, res) => {
  const wr = writableCheck();
  let logSize = null;
  try { logSize = fs.statSync(LOG_FILE).size; } catch {}
  const snap = lagSnapshot();
  OK(res, {
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    node: process.version,
    env: {
      LOG_LEVEL, HTTP_LOG, CLIENT_DIR,
      HEARTBEAT_MS, LAG_SAMPLE_MS, LAG_WARN_MS, LAG_FATAL_MS
    },
    memory: Object.fromEntries(Object.entries(process.memoryUsage())
      .map(([k,v]) => [k, Math.round(v/(1024*1024)) + ' MB'])),
    fs: { dataDir: DATA_DIR, writable: wr.ok, writeError: wr.error || null, logFile: LOG_FILE, logBytes: logSize },
    eventLoop: snap
  });
});

// ultra-fast check (exposes if event loop is alive)
app.get('/debug/ping', (_req, res) => res.json({ ok:true, t: Date.now() }));

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

// Settings
app.get('/api/settings/hosts', (_req,res) => {
  const hosts = listHosts();
  const tokens = tokensSummary();
  const arr = hosts.map(h => ({ ...h, tokenSet: !!tokens[h.baseUrl] }));
  OK(res, arr);
});
app.post('/api/settings/host', (req,res) => {
  try { const saved = upsertHost(req.body || {}); info('host.upsert', { base: saved.baseUrl }); OK(res, { host: { ...saved, tokenSet: false } }); }
  catch (e) { FAIL(res, 400, e.message || 'Invalid host data.'); }
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
  if (!r.ok) {
    warn('settings.test.failed', { base, allowSelfSigned: (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false'), err: r.error });
    return FAIL(res, 502, r.error);
  }
  OK(res, { system: r.data?.system || null });
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
  if (REPORT_ON_ERR) {
    try { writeDiagReport('request.error', err); } catch {}
  }
  const status = Number(err?.status) || 500;
  res.status(status).json({ ok:false, error: err?.message || 'Internal Server Error' });
});

/* ================================== Start =================================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  info('server.start', { port: PORT, clientDir: CLIENT_DIR });
  const wr = writableCheck();
  if (!wr.ok) warn('dataDir.writable.fail', { error: wr.error });
  console.log(`Unraid Dashboard listening on :${PORT}`);
});
