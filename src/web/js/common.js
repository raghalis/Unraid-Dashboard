export const qs  = (sel, el = document) => el.querySelector(sel);
export const qsa = (sel, el = document) => Array.from(el.querySelectorAll(sel));

export function link(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = text;
  return a;
}

export function pill(text) {
  const span = document.createElement("span");
  const t = String(text || "").toLowerCase();
  span.className = "pill";
  span.textContent = text || "OK";
  if (t.includes("error")) span.classList.add("bad");
  else if (t.includes("parity")) span.classList.add("warn");
  else if (t.includes("offline")) span.classList.add("muted");
  else span.classList.add("ok");
  return span;
}
