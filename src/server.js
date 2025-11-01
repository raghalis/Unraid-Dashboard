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

/* ------------------------------- Paths ---------------------------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(__dirname, 'web');

/* -------------------------------- Env ----------------------------------- */
const PORT   = process.env.PORT || 8080;
const APPVER = process.env.npm_package_version || '0.0.0';
const DATA_DIR = '/app/data';
const LOG_PATH = path.join(DATA_DIR, 'app.log');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* Optional: allow insecure TLS for self-signed targets */
if ((process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/* ----------------------------- Local logger ------------------------------ */
/* Human-readable, local-time, concise. LOG_LEVEL: error|warn|info|debug */
const LEVELS = ['error','warn','info','debug'];
const MIN_LVL = Math.max(0, LEVELS.indexOf((process.env.LOG_LEVEL || 'info').toLowerCase()));
function ts() { return new Date().toLocaleString(); }
function write(line) { try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {} }
function out(level, msg, ctx = {}) {
  const lvlIdx = LEVELS.indexOf(level);
  if (lvlIdx > MIN_LVL) return;
  const extras = Object.entries(ctx).map(([k,v])=>{
    try { return `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`; }
    catch { return `${k}=[unserializable]`; }
  }).join(' ');
  const line = `[${ts()}] ${level.toUpperCase()} ${msg}${extras ? ' | ' + extras : ''}`;
  console.log(line);
  write(line);
}
const info  = (m,c)=>out('info',m,c);
const warn  = (m,c)=>out('warn',m,c);
const error = (m,c)=>out('error',m,c);
const debug = (m,c)=>out('debug',m,c);

/* ------------------------------ App setup -------------------------------- */
const app = express();
initStore();
app.use(express.json({ limit: '1mb' }));
app.use(nocache());

/* ---------------------------- HTTP logger -------------------------------- */
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    info('http', { method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

/* ----------------------------- Basic Auth -------------------------------- */
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

/* -------------------------------- CSRF ----------------------------------- */
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

/* --------------------------- Health & Version ----------------------------- */
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/version', (_req, res) => res.json({ version: APPVER }));

/* ------------------------------ Static UI -------------------------------- */
app.use('/', express.static(CLIENT_DIR));

/* --------------------------- Helpers (HTTP) ------------------------------- */
// Smart OK: arrays are returned as-is (so the client gets an array); objects get ok:true wrapper
const OK  = (res, payload) => Array.isArray(payload)
  ? res.json(payload)
  : res.json(Object.assign({ ok:true }, payload || {}));
const FAIL= (res, status, message, details)=>res.status(status).json({ ok:false, error:message, message, details });

/* ------------------------------- API ------------------------------------- */
/* Resilient servers endpoint: never fails the whole payload because one host is bad */
app.get('/api/servers', async (_req, res) => {
  const hosts = listHosts();
  const settled = await Promise.allSettled(
    hosts.map(async h => {
      try {
        const st = await getHostStatus(h.baseUrl);
        if (!st || typeof st !== 'object') {
          // normalize truly odd returns
          return {
            name: h.name, baseUrl: h.baseUrl, mac: h.mac,
            status: { code:'offline', label:'Offline' },
            metrics: { cpuPct:null, ramPct:null, storagePct:null },
            error: 'Empty response'
          };
        }
        // Honor ok flag if provided by api/unraid.js; otherwise assume ok with data present
        const ok = !!st.ok || !!st.data || !!st.status || !!st.metrics;
        const normalized = {
          name: h.name,
          baseUrl: h.baseUrl,
          mac: h.mac,
          status: st.status || st.data || { code: ok ? 'ok' : 'unknown', label: ok ? 'OK' : 'Unknown' },
          metrics: st.metrics || { cpuPct: st.cpuPct ?? null, ramPct: st.ramPct ?? null, storagePct: st.storagePct ?? null },
          error: ok ? null : (st.error || null),
        };
        return normalized;
      } catch (e) {
        // belt & suspenders: wrap any thrown error
        warn('status.partial', { base: h.baseUrl, err: String(e?.message || e) });
        return {
          name: h.name, baseUrl: h.baseUrl, mac: h.mac,
          status: { code:'offline', label:'Offline' },
          metrics: { cpuPct:null, ramPct:null, storagePct:null },
          error: e?.message || String(e)
        };
      }
    })
  );

  const out = settled.map((r, i) => r.status === 'fulfilled'
    ? r.value
    : ({
        name: hosts[i].name,
        baseUrl: hosts[i].baseUrl,
        mac: hosts[i].mac,
        status: { code:'offline', label:'Offline' },
        metrics: { cpuPct:null, ramPct:null, storagePct:null },
        error: r.reason?.message || String(r.reason || '')
      })
  );

  info('servers.list', { count: out.length });
  OK(res, out); // returns an array
});

/* Containers */
app.get('/api/host/docker', async (req, res) => {
  const base = String(req.query.base || '');
  try { const items = await listContainers(base); OK(res, items); } // array
  catch (e) { error('docker.list', { base, err: String(e) }); FAIL(res, 502, 'Failed to list containers. See logs for details.'); }
});
app.post('/api/host/docker/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try { await containerAction(base, id, action); OK(res, {}); }
  catch (e) { error('docker.action', { base, id, action, err: String(e) }); FAIL(res, 502, `Container ${action} failed: ${e.message}`); }
});

/* VMs */
app.get('/api/host/vms', async (req, res) => {
  const base = String(req.query.base || '');
  try { const items = await listVMs(base); OK(res, items); } // array
  catch (e) { error('vms.list', { base, err: String(e) }); FAIL(res, 502, 'Failed to list VMs. See logs for details.'); }
});
app.post('/api/host/vm/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try { await vmAction(base, id, action); OK(res, {}); }
  catch (e) { error('vm.action', { base, id, action, err: String(e) }); FAIL(res, 502, `VM ${action} failed: ${e.message}`); }
});

/* Power/WOL */
app.post('/api/host', async (req, res) => {
  const base = String(req.query.base || '');
  const kind = String(req.query.action || '');
  const { action } = req.body || {};
  const host = listHosts().find(h => h.baseUrl === base);
  if (!host) return FAIL(res, 404, 'Unknown host. Check Server Address.');
  try {
    if (kind === 'power') {
      if (action === 'wake') {
        await sendWol(host.mac, process.env.WOL_BROADCAST || '255.255.255.255', process.env.WOL_INTERFACE || 'eth0');
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

/* Settings (hosts/tokens) */
app.get('/api/settings/hosts', (_req,res) => {
  const hosts = listHosts();
  const tokens = tokensSummary();
  const arr = hosts.map(h => ({ ...h, tokenSet: !!tokens[h.baseUrl] }));
  OK(res, arr); // array
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
  try {
    const r = await getHostStatus(base);
    if (!r || r.ok === false) {
      const msg = r?.error || 'Test failed';
      warn('settings.test.failed', { base, allowSelfSigned: (process.env.UNRAID_ALLOW_SELF_SIGNED || 'false'), err: msg });
      return FAIL(res, 502, msg);
    }
    OK(res, { system: r.data?.system || null });
  } catch (e) {
    warn('settings.test.error', { base, err: String(e) });
    FAIL(res, 502, e?.message || 'Test failed');
  }
});

/* Settings UI */
app.get('/settings', (_req,res)=>res.sendFile(path.join(CLIENT_DIR,'settings.html')));

/* --------------------------- Error handler last -------------------------- */
app.use((err, req, res, _next) => {
  error(err?.message || 'Unhandled error', { url: req?.originalUrl, stack: err?.stack });
  res.status(500).json({ ok:false, message:'Internal error' });
});

/* -------------------------------- Start ---------------------------------- */
app.listen(PORT, () => {
  info('server.start', { port: PORT, version: APPVER, clientDir: CLIENT_DIR });
  console.log(`Unraid Dashboard listening on :${PORT}`);
});