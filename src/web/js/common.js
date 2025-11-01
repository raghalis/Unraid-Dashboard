/* ===== common.js: shell + helpers ===== */

export const q = (s, r=document) => r.querySelector(s);
export const qa = (s, r=document) => Array.from(r.querySelectorAll(s));
export const val = s => q(s)?.value ?? '';
export const setVal = (s,v) => { const el=q(s); if(el) el.value=v; };

let toastTimer=null;
export function toast(msg, kind='ok'){
  let t = q('#toast'); if(!t){ t=document.createElement('div'); t.id='toast'; t.className='toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.style.borderColor = kind==='bad' ? '#7a2a2a' : (kind==='warn' ? '#8a6a00' : '#294c89');
  t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.classList.remove('show'), 2500);
}

/* Build sticky header + drawer + footer (no top links) */
export async function buildShell(active){
  // Header (hamburger + title)
  const h = document.createElement('div');
  h.className = 'header';
  h.innerHTML = `
    <div class="hamburger" id="hamb"><span></span></div>
    <div class="title">Unraid Control</div>
    <div class="spacer"></div>`;
  document.body.prepend(h);

  // Drawer
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop'; backdrop.id = 'drawerBackdrop';
  const drawer = document.createElement('div'); drawer.className='drawer'; drawer.id='drawer';
  drawer.innerHTML = `
    <div class="brand">Unraid Control</div>
    <div class="section">Pages</div>
    <a href="/" ${active==='dash'?'class="active"':''}>Dashboard</a>
    <a href="/settings" ${active==='settings'?'class="active"':''}>Settings</a>`;
  document.body.append(backdrop, drawer);

  const toggle = (open)=>{ drawer.classList.toggle('open', open); backdrop.classList.toggle('open', open); };
  q('#hamb').onclick = ()=>toggle(true);
  backdrop.onclick = ()=>toggle(false);

  // Footer with version
  try {
    const r = await fetch('/version'); const j = await r.json();
    const foot = document.createElement('div');
    foot.className='footer'; foot.innerHTML = `Unraid Control • v${j?.version ?? '0.0.0'}`;
    document.body.append(foot);
  } catch {
    const foot = document.createElement('div');
    foot.className='footer'; foot.textContent='Unraid Control';
    document.body.append(foot);
  }
}