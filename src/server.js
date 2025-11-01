import express from 'express';
import path from 'path';
import fs from 'fs';
import nocache from 'nocache';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  initStore, listHosts, upsertHost, deleteHost,
  setToken, tokensSummary, getAppSettings, setAppSettings
} from './store/configStore.js';
import {
  getHostStatus, listContainers, listVMs,
  containerAction, vmAction, powerAction
} from './api/unraid.js';
import { sendWol } from './api/wol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/* =============================== logging =============================== */

const DATA_DIR = '/app/data';
const LOG_PATH = path.join(DATA_DIR, 'app.log');
fs.mkdirSync(DATA_DIR, { recursive: true });

const LV = { error: 0, warn: 1, info: 2, debug: 3 };
function nowLocal() {
  return new Intl.DateTimeFormat(undefined, {
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    hour12:false
  }).format(new Date());
}
function should(level){ return (LV[getAppSettings().logLevel] ?? 2) >= (LV[level] ?? 2); }
function write(line){ console.log(line); try{ fs.appendFileSync(LOG_PATH, line+'\n'); }catch{} }
function log(level, msg, ctx) {
  if (!should(level)) return;
  const { debugHttp } = getAppSettings();
  const tail = (debugHttp && ctx) ? ` | ${Object.entries(ctx).map(([k,v]) => `${k}=${typeof v==='string'?v:JSON.stringify(v)}`).join(' ')}` : '';
  write(`[${nowLocal()}] ${level.toUpperCase()} ${msg}${tail}`);
}
const info=(m,c)=>log('info',m,c);
const warn=(m,c)=>log('warn',m,c);
const error=(m,c)=>log('error',m,c);
const debug=(m,c)=>log('debug',m,c);

/* ================================ setup ================================ */

initStore();
app.use(express.json({ limit: '1mb' }));
app.use(nocache());

/* optional HTTP access log (only in debug mode) */
app.use((req,res,next)=>{
  if (!getAppSettings().debugHttp) return next();
  const t0 = Date.now();
  res.on('finish', ()=> info('HTTP', { method:req.method, url:req.originalUrl, status:res.statusCode, ms:Date.now()-t0 }));
  next();
});

/* health/version */
app.get('/health', (_req,res)=>res.status(200).type('text/plain').send('ok'));
app.get('/version', (_req,res)=>{
  let version='0.0.0'; try{ version=JSON.parse(fs.readFileSync(path.join(__dirname,'..','package.json'),'utf8')).version||version; }catch{}
  res.json({ version });
});

/* static */
app.use('/', express.static(path.join(__dirname, 'web')));

/* helpers */
const OK  = (res, payload) => Array.isArray(payload) ? res.json(payload) : res.json(Object.assign({ ok:true }, payload || {}));
const FAIL= (res, code, message, details) => res.status(code).json({ ok:false, error:message, message, details });

/* ================================ API ================================= */

/* Dashboard list with partial-success handling */
app.get('/api/servers', async (_req, res) => {
  const hosts = listHosts();
  const out = await Promise.all(hosts.map(async h => {
    const st = await getHostStatus(h.baseUrl);
    if (!st.ok) {
      warn('Status check failed');
      return { name:h.name, baseUrl:h.baseUrl, mac:h.mac, status:null, error:st.error };
    }
    if (st.warnings?.length) warn('Partial data received');
    return { name:h.name, baseUrl:h.baseUrl, mac:h.mac, status:st.data, warnings:st.warnings||[] };
  }));
  OK(res, out);
});

/* Containers */
app.get('/api/host/docker', async (req,res)=>{
  try{ OK(res, await listContainers(String(req.query.base||''))); }
  catch(e){ error('Container list failed'); FAIL(res,502,'Failed to list containers.'); }
});
app.post('/api/host/docker/action', async (req,res)=>{
  const base=String(req.query.base||''); const {id,action}=req.body||{};
  try{ await containerAction(base,id,action); OK(res,{}); }
  catch(e){ error(`Container ${action} failed`); FAIL(res,502,`Container ${action} failed: ${e.message}`);}
});

/* VMs */
app.get('/api/host/vms', async (req,res)=>{
  try{ OK(res, await listVMs(String(req.query.base||''))); }
  catch(e){ error('VM list failed'); FAIL(res,502,'Failed to list VMs.'); }
});
app.post('/api/host/vm/action', async (req,res)=>{
  const base=String(req.query.base||''); const {id,action}=req.body||{};
  try{ await vmAction(base,id,action); OK(res,{}); }
  catch(e){ error(`VM ${action} failed`); FAIL(res,502,`VM ${action} failed: ${e.message}`); }
});

/* Power/WOL */
app.post('/api/host', async (req,res)=>{
  const base = String(req.query.base || '');
  const kind = String(req.query.action || '');
  const { action } = req.body || {};
  const host = listHosts().find(h => h.baseUrl === base);
  if (!host) return FAIL(res,404,'Unknown host.');
  try{
    if (kind==='power' && action==='wake'){
      await sendWol(host.mac, process.env.WOL_BROADCAST||'255.255.255.255', process.env.WOL_INTERFACE||'eth0');
      info('Sent WOL packet'); return OK(res,{});
    }
    return FAIL(res,400,'Unsupported action.');
  }catch(e){ error('Power action failed'); FAIL(res,502,`Power action failed: ${e.message}`); }
});

/* Settings: hosts */
app.get('/api/settings/hosts', (_req,res)=>{
  const tokens=tokensSummary();
  OK(res, listHosts().map(h=>({...h, tokenSet: !!tokens[h.baseUrl]})));
});

/* Save or Edit host: test before commit; success returns warnings if any */
app.post('/api/settings/host', async (req,res)=>{
  const { name, baseUrl, mac, token, oldBaseUrl } = req.body || {};
  try{
    if (!name || !baseUrl || !mac || !token) throw new Error('Missing fields.');
    setToken(baseUrl, token);
    const test = await getHostStatus(baseUrl);
    if (!test.ok) throw new Error(test.error || 'Validation failed.');
    const saved = upsertHost({ name, baseUrl, mac });
    if (oldBaseUrl && oldBaseUrl !== baseUrl) { try{ deleteHost(oldBaseUrl); }catch{} }
    if (test.warnings?.length) warn('Partial data during save');
    OK(res, { host:{...saved, tokenSet:true}, warnings:test.warnings||[] });
  }catch(e){ error('Host save failed'); FAIL(res,400,e.message||'Invalid host data.'); }
});
app.delete('/api/settings/host', (req,res)=>{
  try{ deleteHost(String(req.query.base||'')); OK(res,{}); }
  catch{ FAIL(res,400,'Failed to delete host.'); }
});
app.post('/api/settings/token', (req,res)=>{
  try{ setToken(req.body?.baseUrl, req.body?.token); OK(res,{}); }
  catch(e){ FAIL(res,400,e.message||'Failed to save token.'); }
});
app.get('/api/settings/test', async (req,res)=>{
  const r = await getHostStatus(String(req.query.base||''));
  if (!r.ok) { warn('Connection test failed'); return FAIL(res,502,r.error); }
  if (r.warnings?.length) warn('Connection test partial');
  OK(res, { system:r.data?.system||null, warnings:r.warnings||[] });
});

/* App-level runtime settings (incl. refreshSeconds) */
app.get('/api/app', (_req,res)=>OK(res, { settings:getAppSettings() }));
app.post('/api/app', (req,res)=>{
  const patch = {};
  if (typeof req.body?.debugHttp === 'boolean') patch.debugHttp = req.body.debugHttp;
  if (req.body?.logLevel) patch.logLevel = req.body.logLevel;
  if (typeof req.body?.allowSelfSigned === 'boolean') patch.allowSelfSigned = req.body.allowSelfSigned;
  if (Number.isFinite(+req.body?.refreshSeconds) && +req.body.refreshSeconds >= 5) patch.refreshSeconds = Math.floor(+req.body.refreshSeconds);
  OK(res, { settings:setAppSettings(patch) });
});

/* pages */
app.get('/settings', (_req,res)=>res.sendFile(path.join(__dirname,'web','settings.html')));

/* start */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  let version='0.0.0'; try{ version=JSON.parse(fs.readFileSync(path.join(__dirname,'..','package.json'),'utf8')).version; }catch{}
  info(`server.start | port=${PORT} version=${version}`);
  console.log(`Unraid Dashboard listening on :${PORT}`);
});