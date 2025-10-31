import express from 'express';
import path from 'path';
import fs from 'fs';
import nocache from 'nocache';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { basicAuth } from './auth/basicAuth.js'; // inlined below for simplicity if needed
import { sendWol } from './api/wol.js';
import {
  getHostStatus, listContainers, listVMs,
  containerAction, vmAction, powerAction
} from './api/unraid.js';

import {
  initStore, listHosts, upsertHost, deleteHost,
  setToken, tokensSummary
} from './store/configStore.js';

// ---- Setup ----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(nocache());

// ---- Basic Auth ----
const USER = process.env.BASIC_AUTH_USER || '';
const PASS = process.env.BASIC_AUTH_PASS || '';
app.use((req, res, next) => {
  if (!USER || !PASS) return next();
  import('basic-auth').then(({ default: auth }) => {
    const creds = auth(req);
    if (!creds || creds.name !== USER || creds.pass !== PASS) {
      res.set('WWW-Authenticate', 'Basic realm="Restricted"');
      return res.status(401).send('Authentication required.');
    }
    next();
  });
});

// ---- CSRF (double-submit cookie) ----
const CSRF_NAME = 'ucp_csrf';
const CSRF = process.env.CSRF_SECRET || crypto.randomBytes(16).toString('hex');
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
app.use((req, res, next) => {
  const secure = (req.protocol === 'https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${CSRF_NAME}=${encodeURIComponent(CSRF)}; Path=/; HttpOnly; SameSite=Lax${secure}`);

  if (req.method !== 'GET' && req.path.startsWith('/api/')) {
    const cookieTok = getCookie(req, CSRF_NAME);
    const headerTok = req.headers['x-csrf-token'] || '';
    if (!cookieTok || cookieTok !== headerTok) {
      return res.status(403).json({ error: 'Bad CSRF' });
    }
  }
  next();
});

// ---- Store init ----
initStore();

// ---- Static UI ----
app.use('/', express.static(path.join(__dirname, 'web')));

// ---- API: overview ----
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
  res.json(result);
});

// ---- API: Docker ----
app.get('/api/host/docker', async (req, res) => {
  try {
    res.json(await listContainers(String(req.query.base || '')));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.post('/api/host/docker/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try {
    const r = await containerAction(base, id, action);
    res.json({ ok: true, r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- API: VMs ----
app.get('/api/host/vms', async (req, res) => {
  try {
    res.json(await listVMs(String(req.query.base || '')));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.post('/api/host/vm/action', async (req, res) => {
  const base = String(req.query.base || '');
  const { id, action } = req.body || {};
  try {
    const r = await vmAction(base, id, action);
    res.json({ ok: true, r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- API: Power/WOL ----
app.post('/api/host', async (req, res) => {
  const kind = String(req.query.action || '');
  const base = String(req.query.base || '');
  const { action } = req.body || {}; // wake|reboot|shutdown

  const host = listHosts().find(h => h.baseUrl === base);
  if (!host) return res.status(404).json({ ok: false, error: 'Unknown host' });

  try {
    if (kind === 'power') {
      if (action === 'wake') {
        await sendWol(host.mac, process.env.WOL_BROADCAST || '255.255.255.255', process.env.WOL_INTERFACE || 'eth0');
        return res.json({ ok: true });
      }
      if (action === 'reboot' || action === 'shutdown') {
        const r = await powerAction(base, action);
        return res.json({ ok: true, r });
      }
    }
    res.status(400).json({ ok: false, error: 'Unsupported action' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- Settings API ----
app.get('/api/settings/hosts', (req, res) => {
  const hosts = listHosts();
  const tokens = tokensSummary();
  res.json(hosts.map(h => ({ ...h, tokenSet: !!tokens[h.baseUrl] })));
});

app.post('/api/settings/host', (req, res) => {
  try {
    const saved = upsertHost(req.body || {});
    const tokenSet = !!tokensSummary()[saved.baseUrl];
    res.json({ ok: true, host: { ...saved, tokenSet } });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.delete('/api/settings/host', (req, res) => {
  try {
    deleteHost(String(req.query.base || ''));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/settings/token', (req, res) => {
  const { baseUrl, token } = req.body || {};
  try {
    setToken(baseUrl, token);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/settings/test', async (req, res) => {
  const base = String(req.query.base || '');
  try {
    const r = await getHostStatus(base);
    if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
    res.json({ ok: true, system: r.data?.system || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- Settings page ----
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'settings.html'));
});

// ---- Start ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Unraid Dashboard listening on :${PORT}`));
