import express from 'express';
import path from 'path';
import fs from 'fs';
import nocache from 'nocache';
import { fileURLToPath } from 'url';
import { basicAuth } from './auth/basicAuth.js';
import { sendWol } from './api/wol.js';
import { getHostStatus, listContainers, listVMs, containerAction, vmAction, powerAction } from './api/unraid.js';
import crypto from 'crypto';
import { initStore, listHosts, upsertHost, deleteHost, setToken, tokensSummary } from './store/configStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(nocache());

initStore();

// CSRF token (simple per-process)
const CSRF = crypto.randomBytes(16).toString('hex');
app.use((req, res, next) => {
  res.set('X-CSRF-Token', CSRF);
  if (req.method !== 'GET' && req.path.startsWith('/api/')) {
    if (req.headers['x-csrf-token'] !== CSRF) return res.status(403).json({ error: 'Bad CSRF' });
  }
  next();
});

// Auth
const USER = process.env.BASIC_AUTH_USER || '';
const PASS = process.env.BASIC_AUTH_PASS || '';
app.use(basicAuth(USER, PASS));

// Load hosts
const hostsPath = path.join(__dirname, '..', 'config', 'hosts.json');
function loadHosts() {
  if (!fs.existsSync(hostsPath)) return [];
  return JSON.parse(fs.readFileSync(hostsPath, 'utf8'));
}

// Static UI
app.use('/', express.static(path.join(__dirname, 'web')));

// API
app.get('/api/servers', async (req, res) => {
  const hosts = loadHosts();
  const result = await Promise.all(hosts.map(async h => {
    const status = await getHostStatus(h.baseUrl);
    return { name: h.name, baseUrl: h.baseUrl, mac: h.mac, status: status.ok ? status.data : null, error: status.ok ? null : status.error };
  }));
  res.json(result);
});

app.get('/api/host/docker', async (req, res) => {
  const base = req.query.base;
  try {
    const items = await listContainers(base);
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/host/docker/action', async (req, res) => {
  const base = req.query.base;
  const { id, action } = req.body;
  try {
    const r = await containerAction(base, id, action);
    res.json({ ok: true, r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/host/vms', async (req, res) => {
  const base = req.query.base;
  try {
    const items = await listVMs(base);
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/host/vm/action', async (req, res) => {
  const base = req.query.base;
  const { id, action } = req.body;
  try {
    const r = await vmAction(base, id, action);
    res.json({ ok: true, r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/host', async (req, res) => {
  const { action } = req.query; // 'power'
  const base = req.query.base;
  const { action: bodyAction } = req.body; // wake|reboot|shutdown
  const hosts = loadHosts();
  const host = hosts.find(h => h.baseUrl === base);
  if (!host) return res.status(404).json({ ok: false, error: 'Unknown host' });

  try {
    if (action === 'power') {
      if (bodyAction === 'wake') {
        await sendWol(host.mac, process.env.WOL_BROADCAST || '255.255.255.255', process.env.WOL_INTERFACE || 'eth0');
        return res.json({ ok: true });
      }
      if (bodyAction === 'reboot' || bodyAction === 'shutdown') {
        const r = await powerAction(base, bodyAction);
        return res.json({ ok: true, r });
      }
    }
    return res.status(400).json({ ok: false, error: 'Unsupported action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Settings API
app.get('/api/settings/hosts', (req, res) => {
  const hosts = listHosts();
  const tokens = tokensSummary();
  // mask tokens; client only knows whether one is set
  const withMask = hosts.map(h => ({ ...h, tokenSet: !!tokens[h.baseUrl] }));
  res.json(withMask);
});

app.post('/api/settings/host', (req, res) => {
  try {
    const saved = upsertHost(req.body || {});
    res.json({ ok: true, host: { ...saved, tokenSet: tokensSummary()[saved.baseUrl] || false } });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.delete('/api/settings/host', (req, res) => {
  const base = String(req.query.base || '');
  try {
    deleteHost(base);
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

// Settings page
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'settings.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Unraid Control Panel listening on :${PORT}`));
