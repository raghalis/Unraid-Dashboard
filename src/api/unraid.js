import fetch from "node-fetch";
import https from "https";

const agentCache = new Map();
function getAgent(allowSelfSigned) {
  const key = allowSelfSigned ? "insecure" : "secure";
  if (!agentCache.has(key)) {
    agentCache.set(key, new https.Agent({
      rejectUnauthorized: !allowSelfSigned,
      keepAlive: true,
    }));
  }
  return agentCache.get(key);
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function gql(base, token, query, variables, allowSelfSigned) {
  const res = await fetch(`${base}/graphql`, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
    headers: authHeaders(token),
    agent: getAgent(allowSelfSigned),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`GraphQL non-JSON ${res.status}`); }
  if (!res.ok || json.errors) {
    const msg = json?.errors?.[0]?.message || `GraphQL ${res.status}`;
    throw new Error(msg);
  }
  return json.data;
}

// robust parse utils
const num = v => (typeof v === "number" && isFinite(v) ? v : 0);
const pct = (used, total) => total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;

// Try new schema first, fall back if fields missing
async function fetchArrayStatus(base, token, allowSelfSigned) {
  try {
    const data = await gql(base, token, `
      query Info {
        infoArray {
          started
          operation
          operationProgress
          errors
          capacity {
            total
            free
          }
        }
      }
    `, {}, allowSelfSigned);

    const arr = data?.infoArray || {};
    const total = num(arr?.capacity?.total);
    const free = num(arr?.capacity?.free);
    const used = Math.max(0, total - free);
    const storagePct = pct(used, total);

    // Map to pill text
    let status = "OK";
    if (!arr?.started) status = "Offline";
    if (String(arr?.operation || "").toLowerCase().includes("parity")) {
      const prog = num(arr?.operationProgress);
      status = prog > 0 ? "Parity Check" : "Parity Check";
    }
    if (num(arr?.errors) > 0) status = "Error";

    return { started: !!arr?.started, storagePct, status };
  } catch (e) {
    // Fall back: minimal “array started” and capacity from /api/var if present
    try {
      const res = await fetch(`${base}/api/var`, { headers: authHeaders(token), agent: getAgent(allowSelfSigned) });
      const js = await res.json();
      const started = js?.arrayStarted === true || js?.arrayStarted === "yes";
      const t = num(js?.arrayTotalBytes);
      const f = num(js?.arrayFreeBytes);
      const storagePct = pct(Math.max(0, t - f), t);
      let status = started ? "OK" : "Offline";
      if (String(js?.arrayOp || "").toLowerCase().includes("parity")) status = "Parity Check";
      return { started, storagePct, status };
    } catch {
      // Last resort
      return { started: false, storagePct: 0, status: "Offline" };
    }
  }
}

async function fetchCpuRam(base, token, allowSelfSigned) {
  // Try GraphQL hardware summary; fall back to REST metrics.
  try {
    const data = await gql(base, token, `
      query Hw {
        infoHardware {
          cpuLoadPct
          memory {
            total
            free
          }
        }
      }
    `, {}, allowSelfSigned);
    const load = Math.max(0, Math.min(100, Math.round(num(data?.infoHardware?.cpuLoadPct))));
    const mt = num(data?.infoHardware?.memory?.total);
    const mf = num(data?.infoHardware?.memory?.free);
    const ram = pct(Math.max(0, mt - mf), mt);
    return { cpuPct: load, ramPct: ram };
  } catch {
    try {
      const res = await fetch(`${base}/api/dws/metrics`, { headers: authHeaders(token), agent: getAgent(allowSelfSigned) });
      const js = await res.json();
      const load = Math.round(num(js?.system?.cpu?.overallLoadPct));
      const mt = num(js?.system?.memory?.totalBytes);
      const mf = num(js?.system?.memory?.freeBytes);
      const ram = pct(Math.max(0, mt - mf), mt);
      return { cpuPct: Math.max(0, Math.min(100, load)), ramPct: ram };
    } catch {
      return { cpuPct: 0, ramPct: 0 };
    }
  }
}

export async function testConnection({ base, token, allowSelfSigned }) {
  const r = await fetch(`${base}/version`, {
    headers: authHeaders(token),
    agent: getAgent(allowSelfSigned),
  });
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, status: r.status };
}

export async function fetchPartialStatus({ name, base, mac, token, allowSelfSigned }) {
  const [{ cpuPct, ramPct }, arr] = await Promise.all([
    fetchCpuRam(base, token, allowSelfSigned),
    fetchArrayStatus(base, token, allowSelfSigned),
  ]);

  // Status pill synthesis
  let status = arr.status;
  if (status === "Offline") {
    return { name, base, cpuPct: 0, ramPct: 0, storagePct: 0, status, canWake: Boolean(mac) };
  }
  return {
    name,
    base,
    cpuPct,
    ramPct,
    storagePct: arr.storagePct,
    status,
    canWake: Boolean(mac),
  };
}

// WoL
export async function wake(mac) {
  // Send a magic packet using a tiny UDP implementation without deps.
  const dgram = await import("dgram");
  const socket = dgram.createSocket("udp4");
  const macBytes = mac.replace(/[^A-Fa-f0-9]/g, "").match(/.{1,2}/g).map(h => parseInt(h, 16));
  if (macBytes.length !== 6) throw new Error("Invalid MAC for WOL");
  const buf = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) Buffer.from(macBytes).copy(buf, 6 + i * 6);
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.send(buf, 9, "255.255.255.255", (err) => {
      socket.close();
      if (err) reject(err); else resolve();
    });
    socket.setBroadcast(true);
  });
}
