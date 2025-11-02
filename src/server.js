/* eslint-disable no-console */
import express from "express";
import basicAuth from "express-basic-auth";
import path from "path";
import fs from "fs";
import cors from "cors";
import { fileURLToPath } from "url";
import { fetchPartialStatus, testConnection, wake } from "./unraid.js";

// ---------------------- env & constants ----------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || "";
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const DEBUG_HTTP = String(process.env.DEBUG_HTTP || "false").toLowerCase() === "true";
const ALLOW_SELF_SIGNED = String(process.env.UNRAID_ALLOW_SELF_SIGNED || "true").toLowerCase() === "true";
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------- tiny logger --------------------------
const levels = ["error","warn","info","debug"];
function now() {
  return new Date().toLocaleString(undefined, { hour12: true, timeZone: TZ });
}
function log(level, msg, ctx = null) {
  if (levels.indexOf(level) <= levels.indexOf(LOG_LEVEL)) {
    const line = `[${now()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
    if (ctx && DEBUG_HTTP) {
      console.log(line, ctx);
    } else {
      console.log(line);
    }
  }
}
const L = {
  error: (m,c) => log("error",m,c),
  warn:  (m,c) => log("warn",m,c),
  info:  (m,c) => log("info",m,c),
  debug: (m,c) => log("debug",m,c),
};

// ---------------------- settings io --------------------------
function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      app: {
        autoRefreshSec: 5,
        logLevel: LOG_LEVEL,
        debugHttp: DEBUG_HTTP,
        allowSelfSigned: ALLOW_SELF_SIGNED,
      },
      hosts: [],
    };
  }
}
function writeSettings(obj) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), "utf8");
}

// ---------------------- express app --------------------------
const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true }));

// Static first (no auth)
const clientDir = path.join(__dirname, "web");
app.use(express.static(clientDir, { index: false }));

// Public health & version — **no auth**
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});
app.get("/version", (req, res) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    res.json({ version: pkg.version });
  } catch {
    res.json({ version: "0.0.0" });
  }
});

// Apply basic auth to *API* & *HTML entry points*
// (but not to static files or health/version)
if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
  const auth = basicAuth({
    users: { [BASIC_AUTH_USER]: BASIC_AUTH_PASS },
    challenge: true,
    unauthorizedResponse: () => "Unauthorized",
  });

  // Protect API routes
  app.use((req, res, next) => {
    const open = req.path === "/health" || req.path === "/version" || req.path.startsWith("/css/") || req.path.startsWith("/js/") || req.path.startsWith("/assets/");
    if (open) return next();
    if (req.path.startsWith("/api")) return auth(req, res, next);
    return next();
  });

  // Protect HTML entry points (/, /dashboard, /settings)
  const protectHtml = ["/", "/dashboard", "/settings"];
  protectHtml.forEach(route => app.get(route, auth, (req, res, next) => next()));
}

// ---------------------- http access log (human) --------------
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const ctx = DEBUG_HTTP ? { method: req.method, url: req.originalUrl, status: res.statusCode, ms } : undefined;
    L.info("http", ctx);
  });
  next();
});

// ---------------------- API: settings ------------------------
app.get("/api/settings/hosts", (req, res) => {
  const s = readSettings();
  res.json(s.hosts || []);
});
app.post("/api/settings/hosts", (req, res) => {
  const { name, base, mac, token } = req.body || {};
  if (!name || !base || !token) {
    return res.status(400).json({ error: "name, base and token are required" });
  }
  const s = readSettings();
  const exists = (s.hosts || []).find(h => h.base === base);
  if (exists) return res.status(409).json({ error: "Host already exists" });
  s.hosts.push({ name, base, mac: mac || "", token, addedAt: Date.now() });
  writeSettings(s);
  res.json({ ok: true });
});
app.put("/api/settings/hosts", (req, res) => {
  const { base, patch } = req.body || {};
  if (!base || !patch) return res.status(400).json({ error: "base and patch are required" });
  const s = readSettings();
  const idx = (s.hosts || []).findIndex(h => h.base === base);
  if (idx < 0) return res.status(404).json({ error: "Host not found" });
  s.hosts[idx] = { ...s.hosts[idx], ...patch, updatedAt: Date.now() };
  writeSettings(s);
  res.json({ ok: true });
});
app.delete("/api/settings/hosts", (req, res) => {
  const { base } = req.query;
  if (!base) return res.status(400).json({ error: "base required" });
  const s = readSettings();
  s.hosts = (s.hosts || []).filter(h => h.base !== String(base));
  writeSettings(s);
  res.json({ ok: true });
});

// App settings
app.get("/api/app", (req, res) => {
  const s = readSettings();
  res.json(s.app || {});
});
app.post("/api/app", (req, res) => {
  const s = readSettings();
  s.app = {
    ...s.app,
    ...req.body,
  };
  writeSettings(s);
  L.info("app.settings", s.app);
  res.json({ ok: true });
});

// ---------------------- API: connectivity & status -----------
app.post("/api/test", async (req, res) => {
  const { base, token, allowSelfSigned } = req.body || {};
  try {
    const r = await testConnection({ base, token, allowSelfSigned: allowSelfSigned ?? ALLOW_SELF_SIGNED });
    res.json(r);
  } catch (e) {
    L.warn("test.failed", { base, err: String(e?.message || e) });
    res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/servers", async (_req, res) => {
  const s = readSettings();
  const hosts = s.hosts || [];
  res.json(hosts.map(h => ({ name: h.name, base: h.base })));
});

app.get("/api/status/partial", async (_req, res) => {
  const s = readSettings();
  const hosts = s.hosts || [];
  L.info("servers.list", { count: hosts.length });
  const results = await Promise.all(hosts.map(async (h) => {
    try {
      const stat = await fetchPartialStatus({
        name: h.name,
        base: h.base,
        mac: h.mac || "",
        token: h.token,
        allowSelfSigned: s?.app?.allowSelfSigned ?? ALLOW_SELF_SIGNED,
      });
      return { ok: true, ...stat };
    } catch (e) {
      L.warn("status.partial", { base: h.base, error: String(e?.message || e) });
      return {
        ok: false,
        name: h.name,
        base: h.base,
        status: "Offline",
        cpuPct: 0,
        ramPct: 0,
        storagePct: 0,
        canWake: Boolean(h.mac),
      };
    }
  }));
  res.json({ hosts: results });
});

// Wake-on-LAN
app.post("/api/wake", async (req, res) => {
  const { mac, base } = req.body || {};
  if (!mac) return res.status(400).json({ error: "mac required" });
  try {
    await wake(mac);
    L.info("wol.sent", { base, mac });
    res.json({ ok: true });
  } catch (e) {
    L.error("wol.failed", { mac, err: String(e?.message || e) });
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------------- HTML entries -------------------------
app.get("/", (_req, res) => res.sendFile(path.join(clientDir, "dashboard.html")));
app.get("/dashboard", (_req, res) => res.sendFile(path.join(clientDir, "dashboard.html")));
app.get("/settings", (_req, res) => res.sendFile(path.join(clientDir, "settings.html")));

// ---------------------- start -------------------------------
app.listen(PORT, () => {
  L.info(`server.start | port=${PORT} version=${readPackageVersion()} clientDir=${clientDir}`);
  console.log("Unraid Dashboard listening on :", PORT);
});

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
