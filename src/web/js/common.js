export const q = (s, r=document) => r.querySelector(s);
export const el = (tag, cls, txt) => { const n=document.createElement(tag); if(cls) n.className=cls; if(txt!=null) n.textContent=txt; return n; };
export const val = s => q(s)?.value || '';
export const setVal = (s,v)=>{ const n=q(s); if(n) n.value=v; };

export function fmtPct(v){ return Number.isFinite(+v) ? `${Math.round(+v)}%` : '—'; }

export function toast(msg,type='info'){
  let t=q('#toast'); if(!t){ t=el('div','toast'); t.id='toast'; document.body.appendChild(t); }
  t.className = `toast ${type}`; t.textContent = msg; t.style.opacity='1';
  setTimeout(()=>t.style.opacity='0', 2000);
}

window.addEventListener('DOMContentLoaded', async ()=>{
  // version bubble
  try{ const r=await fetch('/version'); const j=await r.json(); const v=q('#ver'); if(v) v.textContent=`v${j.version}`; }catch{}
});