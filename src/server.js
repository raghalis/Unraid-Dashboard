// src/server.js
import express from 'express';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { gql, TEST_QUERY } from './api/unraid.js';

const app = express();
const logger = pino({
  transport: { target: 'pino-pretty', options: { translateTime: true, colorize: true } }
});

const PORT = process.env.PORT || 8080;
const BASIC_USER = process.env.BASIC_AUTH_USER || 'admin';
const BASIC_PASS = process.env.BASIC_AUTH_PASS || 'change_me';
const ALLOW_SELF_SIGNED = (/^(true|1|yes)$/i).test(process.env.UNRAID_ALLOW_SELF_SIGNED || '');
const APP_ORIGIN = process.env.APP_PUBLIC_ORIGIN || ''; // optional, helps some strict CORS setups

// In-memory settings (persisted on disk)
import fs from 'fs';
import path from 'path';
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const DB_FILE  = path.join(DATA_DIR, 'settings.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { hosts: [] }; }
}
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

app.use(morgan('tiny'));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('src/public', { extensions: ['html'] }));

// Simple Basic Auth middleware (replaces the old CSRF shim)
app.use((req, res, next) => {
  // Allow the UI assets through without auth to show the login prompt page:
  if (/^\/(css|js|img|favicon|$)/.test(req.path)) return next();

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return prompt();
  const b64 = auth.slice(6);
  const [u, p] = Buffer.from(b64, 'base64').toString('utf8').split(':');
  if (u === BASIC_USER && p === BASIC_PASS) return next();
  return prompt();

  function prompt() {
    res.set('WWW-Authenticate', 'Basic realm="Unraid Control"');
    return res.status(401).send('Auth required');
  }
});

// ---- Settings API ----
app.get('/api/settings/hosts', (req, res) => {
  const db = readDB();
  logger.info({ ts: new Date().toISOString(), msg: 'settings.hosts.list', ctx: { count: db.hosts.length } });
  res.json({ hosts: db.hosts });
});

app.post('/api/settings/hosts', (req, res) => {
  const { name, baseUrl, mac, token } = req.body || {};
  if (!name || !baseUrl) return res.status(400).json({ error: 'Name and Base URL are required.' });

  const db = readDB();
  const idx = db.hosts.findIndex(h => h.name.toLowerCase() === name.toLowerCase());
  const item = { id: idx >= 0 ? db.hosts[idx].id : uuidv4(), name, baseUrl, mac: mac || '', token: token || '' };
  if (idx >= 0) db.hosts[idx] = item; else db.hosts.push(item);
  writeDB(db);

  logger.info({ ts: new Date().toISOString(), msg: 'settings.hosts.upsert', ctx: { base: baseUrl, name } });
  res.json({ ok: true, host: item });
});

app.post('/api/settings/token', (req, res) => {
  const { baseUrl, token } = req.body || {};
  if (!baseUrl || !token) return res.status(400).json({ error: 'Base URL and Token are required.' });
  const db = readDB();
  const h = db.hosts.find(x => x.baseUrl === baseUrl);
  if (!h) return res.status(404).json({ error: 'Host not found.' });
  h.token = token;
  writeDB(db);
  logger.info({ ts: new Date().toISOString(), msg: 'settings.token.set', ctx: { base: baseUrl, tokenSet: !!token } });
  res.json({ ok: true });
});

app.post('/api/settings/test', async (req, res) => {
  const { baseUrl } = req.body || {};
  const db = readDB();
  const h = db.hosts.find(x => x.baseUrl === baseUrl) || { baseUrl, token: '' };

  try {
    await gql(logger, {
      baseUrl: h.baseUrl,
      apiKey: h.token,
      query: TEST_QUERY,
      allowSelfSigned: ALLOW_SELF_SIGNED,
      originForCors: APP_ORIGIN || undefined
    });
    logger.info({ ts: new Date().toISOString(), msg: 'settings.test.ok', ctx: { base: h.baseUrl } });
    return res.json({ ok: true, message: 'Connected and schema validated.' });
  } catch (err) {
    const raw = String(err.message || err);
    logger.warn({ ts: new Date().toISOString(), msg: 'settings.test.failed', ctx: { base: h.baseUrl, err: raw } });

    // Friendlier UI text
    let friendly = raw;
    if (/self-?signed/i.test(raw)) friendly = 'The Unraid server is using a self-signed certificate. Enable UNRAID_ALLOW_SELF_SIGNED=true or use a valid cert.';
    if (/x-api-key/i.test(raw) || /unauthorized|401/i.test(raw)) friendly = 'API key rejected or missing. Create an API key in Unraid and paste it here.';
    if (/Cannot query field/i.test(raw)) friendly = 'This app queried a field your Unraid API doesn’t support. Update the app or Unraid to a newer version.';

    return res.status(400).json({ ok: false, error: friendly, details: raw });
  }
});

// ---- Dashboard probes (used by the UI) ----
app.post('/api/probe', async (req, res) => {
  const { baseUrl } = req.body || {};
  const db = readDB();
  const h = db.hosts.find(x => x.baseUrl === baseUrl);
  if (!h) return res.status(404).json({ error: 'Host not found.' });

  try {
    const data = await gql(logger, {
      baseUrl: h.baseUrl,
      apiKey: h.token,
      query: `
        query {
          info { os { distro release uptime } cpu { brand cores threads } }
          array { state }
          dockerContainers { id names state status autoStart }
        }
      `,
      allowSelfSigned: ALLOW_SELF_SIGNED,
      originForCors: APP_ORIGIN || undefined
    });

    return res.json({ ok: true, data });
  } catch (err) {
    const msg = String(err.message || err);
    logger.warn({ ts: new Date().toISOString(), msg: 'probe.failed', ctx: { base: h.baseUrl, err: msg } });
    return res.status(502).json({ ok: false, error: msg });
  }
});

app.listen(PORT, () => {
  logger.info({ ts: new Date().toISOString(), msg: 'server.start', ctx: { port: PORT } });
  console.log(`Unraid Dashboard listening on :${PORT}`);
});
