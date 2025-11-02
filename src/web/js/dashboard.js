import { qs, qsa, fmtPct, pill, link } from "./common.js";

const STATE = {
  timer: null,
  intervalSec: 5,
  running: false,
};

function gauge(el, pct) {
  const bar = el.querySelector(".bar");
  const txt = el.querySelector(".val");
  const p = Math.max(0, Math.min(100, pct|0));
  bar.style.width = `${p}%`;
  // color like Unraid (green→amber→red)
  bar.style.background = p < 60 ? "var(--ok)" : (p < 85 ? "var(--warn)" : "var(--bad)");
  txt.textContent = `${p}%`;
}

function renderHost(card, h) {
  card.querySelector("[data-name]").textContent = h.name;
  const addr = card.querySelector("[data-addr]");
  addr.innerHTML = "";
  addr.appendChild(link(h.base, h.base));

  gauge(card.querySelector("[data-cpu]"), h.cpuPct ?? 0);
  gauge(card.querySelector("[data-ram]"), h.ramPct ?? 0);
  gauge(card.querySelector("[data-sto]"), h.storagePct ?? 0);

  const status = card.querySelector("[data-status]");
  status.innerHTML = "";
  status.appendChild(pill(h.status || "OK"));
  const wolBtn = card.querySelector("[data-wake]");
  if (String(h.status).toLowerCase() === "offline" && h.canWake) {
    wolBtn.style.display = "";
    wolBtn.onclick = async () => {
      wolBtn.disabled = true;
      try {
        const r = await fetch("/api/wake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mac: h.mac, base: h.base }) });
        if (!r.ok) throw new Error("WOL failed");
      } finally {
        wolBtn.disabled = false;
      }
    };
  } else {
    wolBtn.style.display = "none";
  }
}

function hostCardTemplate() {
  const tpl = document.createElement("div");
  tpl.className = "card";
  tpl.innerHTML = `
    <div class="row"><div>Name</div><div data-name>—</div></div>
    <div class="row"><div>Server Address</div><div data-addr>—</div></div>
    <div class="row"><div>CPU%</div>
      <div class="meter" data-cpu><div class="bar"></div><div class="val">0%</div></div>
    </div>
    <div class="row"><div>RAM%</div>
      <div class="meter" data-ram><div class="bar"></div><div class="val">0%</div></div>
    </div>
    <div class="row"><div>Storage%</div>
      <div class="meter" data-sto><div class="bar"></div><div class="val">0%</div></div>
    </div>
    <div class="row"><div>Status</div>
      <div class="status"><button class="btn tiny" data-wake style="display:none">Wake</button><span data-status></span></div>
    </div>`;
  return tpl;
}

async function loadOnce() {
  const res = await fetch("/api/status/partial");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const js = await res.json();
  const wrap = qs("#servers");
  wrap.innerHTML = "";
  js.hosts.forEach(h => {
    const card = hostCardTemplate();
    wrap.appendChild(card);
    renderHost(card, h);
  });
}

async function startLoop() {
  if (STATE.running) return;
  STATE.running = true;
  const res = await fetch("/api/app");
  if (res.ok) {
    const js = await res.json();
    STATE.intervalSec = Math.max(1, Number(js?.autoRefreshSec || 5));
  }
  await loadOnce().catch(()=>{});
  STATE.timer = setInterval(() => { loadOnce().catch(()=>{}); }, STATE.intervalSec * 1000);
}

document.addEventListener("DOMContentLoaded", () => {
  startLoop();
});
