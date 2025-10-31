/* Shared browser helpers */

function $(sel){ return document.querySelector(sel); }
function $all(sel){ return Array.from(document.querySelectorAll(sel)); }

function getCookie(name){
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function csrfHeaders(){
  const tok = getCookie('ucp_csrf');
  return tok ? { 'x-csrf-token': tok } : {};
}

async function jsonFetch(url, opts = {}){
  const hdrs = Object.assign(
    { 'accept':'application/json', 'content-type':'application/json' },
    csrfHeaders(),
    opts.headers || {}
  );
  const res = await fetch(url, Object.assign({}, opts, { headers: hdrs }));
  const text = await res.text();
  let js;
  try { js = text ? JSON.parse(text) : {}; } catch { js = { raw: text }; }
  if (!res.ok) {
    const msg = js?.message || js?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = js;
    throw err;
  }
  return js;
}

function setBadge(el, ok, msg){
  el.className = 'resp ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
}

async function showVersion(){
  try {
    const v = await jsonFetch('/version');
    const node = document.getElementById('appVersion');
    if (node) node.textContent = `v${v.version}`;
  } catch {}
}

document.addEventListener('DOMContentLoaded', showVersion);
