import fs from 'fs';
import path from 'path';

const DATA_DIR = '/app/data';
const HOSTS_PATH = path.join(DATA_DIR, 'hosts.json');
const TOKENS_PATH = path.join(DATA_DIR, 'tokens.json');
const APP_PATH = path.join(DATA_DIR, 'app.json');

let hosts = [];
let tokens = {};
let appSettings = {
  debugHttp: false,
  logLevel: 'info',           // error|warn|info|debug
  allowSelfSigned: false,
  refreshSeconds: 30          // dashboard auto-refresh period
};

export function initStore(){
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try{ hosts = JSON.parse(fs.readFileSync(HOSTS_PATH,'utf8')); }catch{ hosts=[]; }
  try{ tokens = JSON.parse(fs.readFileSync(TOKENS_PATH,'utf8')); }catch{ tokens={}; }
  try{ appSettings = { ...appSettings, ...JSON.parse(fs.readFileSync(APP_PATH,'utf8')) }; }catch{}
}
function persist(file, obj){ try{ fs.writeFileSync(file, JSON.stringify(obj,null,2)); }catch{} }

export function listHosts(){ return hosts.slice(); }
export function upsertHost(h){
  const i = hosts.findIndex(x=>x.baseUrl===h.baseUrl);
  if (i>=0) hosts[i] = {...hosts[i], ...h}; else hosts.push(h);
  persist(HOSTS_PATH, hosts); return h;
}
export function deleteHost(baseUrl){
  hosts = hosts.filter(h=>h.baseUrl!==baseUrl); persist(HOSTS_PATH, hosts);
  delete tokens[baseUrl]; persist(TOKENS_PATH, tokens);
}
export function setToken(baseUrl, token){ tokens[baseUrl]=token; persist(TOKENS_PATH,tokens); }
export function getToken(baseUrl){ return tokens[baseUrl]; }
export function tokensSummary(){ return {...tokens}; }

export function getAppSettings(){ return { ...appSettings }; }
export function setAppSettings(patch){
  appSettings = { ...appSettings, ...patch };
  persist(APP_PATH, appSettings);
  return getAppSettings();
}