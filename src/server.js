import express from 'express';
import path from 'path';
import fs from 'fs';
import nocache from 'nocache';
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

/* ------------------------------- Paths ---------------------------------- */
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(__dirname, 'web');
const DATA_DIR   = '/app/data';
fs.mkdirSync(DATA_DIR, { recursive: true });

/* -------------------------------- Env ----------------------------------- */
const PORT     = process.env.PORT || 8080;
const APPVER   = process.env.npm_package_version || '0.0.0';
const LOG_PATH = path.join(DATA_DIR, 'app.log');

/* Optional: allow insecure TLS for self-signed targets */
if ((process.env.UNRAID_ALLOW_SELF_SIGNED || 'false') === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/* ----------------------------- Local logger ------------------------------ */
const LEVELS  = ['error','warn','info','debug'];
const MIN_LVL = Math.max(0, LEVELS.indexOf((process.env.LOG_LEVEL || 'info').toLowerCase()));
const ts      = () => new Date().toLocaleString();
const write   = (line) => { try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {} };
function log(level, msg, ctx = {}) {
  if (LEVELS.indexOf(level) > MIN_LVL) return;
  const extras = Object.entries(ctx).map(([k,v])=>{
    try { return `${k}=${typeof v==='object' ? JSON.stringify(v) : String(v)}`; }
    catch { return `${k}=[unserializable]`; }
  }).join(' ');
  const line = `[${ts()}] ${level.toUpperCase()} ${msg}${extras ? ' | ' + extras : ''}`;
  console.log(line);
  write(line);
}
const info  = (m,c)=>log('info',m,c);
const warn  = (m,c)=>log('warn',m,c);
const error = (m,c)=>log('error',m,c);
const debug = (m,c)=>log('debug',m,c);

/* ------------------------------ App setup -------------------------------- */
const app = express();
app.set('trust proxy', true);
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

/* --------------------------- Health & Version ----------------------------- */
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/version', (_req, res) => res.json({ version: APPVER }));

/* ------------------------------ Static UI -------------------------------- */
app.use('/', express.static(CLIENT_DIR));

/* --------------------------- API helpers --------------------------------- */
const OK   = (res, payload) => Array.isArray(payload) ? res.json(payload) : res.json({ ok:true, ...payload });
const FAIL = (res, status, message, details) => res.status(status).json({ ok:false, error:message, message, details });

/* -------------------------------- API ------------------------------------ */
/* Servers list – resilient: one bad host doesn’t break the whole response */
app.get('/api/servers', async (_req, res) => {
  const hosts = listHosts();
  const settled = await Promise.allSettled(
    hosts.map(async (h) => {
      try {
        const st = await getHostStatus(h.baseUrl);
        return {
          name: h.name,
          baseUrl: h.baseUrl,
          mac: h.mac,
          status: st?.status || { code: (st?.ok === false ? 'offline' : 'ok'), label: (st?.ok === false ? 'Offline' : 'OK') },
          metrics: {
            cpuPct: st?.metrics?.cpuPct ?? st?.cpuPct ?? null,
            ramPct: st?.metrics?.ramPct ?? st?.ramPct ?? null,
            storagePct: st?.metrics?.storagePct ?? st?.storagePct ?? null
          },
          error: st?.ok === false ? (st?.error || 'Unknown error') : null
        };
      } catch (e) {
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

  const result = settled.map((r, i) => r.status === 'fulfilled'
    ? r.value
    : ({
        name: hosts[i].name, baseUrl: hosts[i].baseUrl, mac: hosts[i].mac,
        status: { code:'offline', label:'Offline' },
        metrics: { cpuPct:null, ramPct:null, storagePct:null },
        error: r.reason?.message || String(r.reason || '')
      })
  );

  info('servers.list', { count: result.length });
  OK(res, result); // array
});

/* Containers */
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

/* VMs */
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

/* Power: WOL (clickable when status shows Offline) */
app.post('/api/host/wake', async (req, res) => {
  const { baseUrl } = req.body || {};
  const host = listHosts().find(h => h.baseUrl === baseUrl);
  if (!host) return FAIL(res, 404, 'Unknown host.');
  try {
    await sendWol(host.mac, process.env.WOL_BROADCAST || '255.255.255.255', process.env.WOL_INTERFACE || 'eth0');
    info('power.wake', { base: host.baseUrl, mac: host.mac });
    OK(res, {});
  } catch (e) {
    error('power.wake.error', { base: host.baseUrl, err: String(e) });
    FAIL(res, 502, `Wake failed: ${e.message}`);
  }
});

/* Settings: hosts & tokens */
app.get('/api/settings/hosts', (_req,res) => {
  const hosts = listHosts();
  const tokens = tokensSummary();
  const arr = hosts.map(h => ({ ...h, tokenSet: !!tokens[h.baseUrl] }));
  OK(res, arr); // array
});

app.post('/api/settings/host', (req,res) => {
  try {
    const saved = upsertHost(req.body || {});
    info('host.upsert', { base: saved.baseUrl });
    OK(res, { host: { ...saved, tokenSet: false } });
  } catch (e) {
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
  try {
    const r = await getHostStatus(base);
    if (!r || r.ok === false) {
      const msg = r?.error || 'Test failed';
      warn('settings.test.failed', { base, err: msg });
      return FAIL(res, 502, msg);
    }
    OK(res, { system: r.data?.system || null });
  } catch (e) {
    warn('settings.test.error', { base, err: String(e) });
    FAIL(res, 502, e?.message || 'Test failed');
  }
});

/* Settings UI route */
app.get('/settings', (_req,res)=>res.sendFile(path.join(CLIENT_DIR,'settings.html')));

/* --------------------------- Last-chance error --------------------------- */
app.use((err, req, res, _next) => {
  error(err?.message || 'Unhandled error', { url: req?.originalUrl, stack: err?.stack });
  res.status(500).json({ ok:false, message:'Internal error' });
});

/* -------------------------------- Start ---------------------------------- */
app.listen(PORT, () => {
  info('server.start', { port: PORT, version: APPVER, clientDir: CLIENT_DIR });
  console.log(`Unraid Dashboard listening on :${PORT}`);
});