// ============================================================
// Web server — plain Node.js (node:http). No Next.js, no framework.
//
// Responsibilities:
//   - REST API under /api/*              (server/routes/*)
//   - the React SPA (dev: Vite middleware, prod: static dist/client)
//   - production start also exposes /api/health for probes
//
// The realtime layer is the collaboration mini-service on :3003, reached by the
// browser through the gateway (?XTransformPort=3003) and by this process over
// loopback (:3004 internal endpoints).
// ============================================================

import "./lib/env.js";
import { createServer, request as httpRequest } from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRouter } from "./lib/router.js";
import { json, sendError } from "./lib/http.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerShareRoutes } from "./routes/share.js";
import { registerAutomationRoutes } from "./routes/automation.js";
import { serviceClient } from "./lib/serviceClient.js";
import { startAutomationWorker, dispatchEvent } from "./lib/automation.js";
import { notifyCommentCreated } from "./lib/notifications.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist", "client");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const isProd = process.env.NODE_ENV === "production";

// The browser's realtime socket targets "?XTransformPort=3003". Behind the
// managed gateway that query is routed to the collab service; when the app is
// served directly (local dev on :3000, or a single-port deployment) nothing
// rewrites it, so we forward it ourselves over loopback. Same public port,
// HTTP long-polling and WebSocket upgrades alike.
const COLLAB_HOST = process.env.COLLAB_HOST || "127.0.0.1";
const COLLAB_PORT = Number(process.env.COLLAB_PORT || 3003);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const router = createRouter();
registerAuthRoutes(router);
registerWorkspaceRoutes(router);
registerFileRoutes(router);
registerGithubRoutes(router);
registerNotificationRoutes(router);
registerAssetRoutes(router);
registerShareRoutes(router);
registerAutomationRoutes(router);

// GET /api/health → this process + a probe of the collaboration service
router.get("/api/health", async (req, res) => {
  const collab = await serviceClient.health();
  return json(res, {
    ok: true,
    runtime: `node ${process.versions.node}`,
    collab: collab.ok ? collab.data : { ok: false, error: collab.data?.error },
  });
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const httpServer = createServer();

let vite = null;
if (!isProd) {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({
    root: ROOT,
    appType: "spa",
    server: {
      middlewareMode: true,
      // share our port so HMR travels through the same gateway as the app
      ws: { server: httpServer },
      fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "db/**"] },
    },
  });
  console.log("[server] dev mode — client served by the Vite middleware");
} else if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.warn(`[server] ${DIST}/index.html is missing — run "npm run build" first`);
}

httpServer.on("request", (req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) sendError(res, err);
    else res.destroy();
  });
});

// WebSocket upgrades for the collab service travel on the same server. Vite's
// HMR listener ignores these (it claims only the vite-hmr/-ping subprotocol).
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (!wantsCollab(url)) return;
  const target = net.connect(COLLAB_PORT, COLLAB_HOST);
  target.on("connect", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const v of value) lines.push(`${key}: ${v}`);
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    target.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  target.on("error", () => socket.destroy());
  socket.on("error", () => target.destroy());
});

// Is this request destined for the collaboration service rather than us?
function wantsCollab(url) {
  return (
    url.pathname.startsWith("/socket.io") ||
    url.searchParams.get("XTransformPort") === String(COLLAB_PORT)
  );
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/health" || url.pathname.startsWith("/api/")) {
    const match = router.match(req.method, url.pathname);
    if (!match) return json(res, { error: "Not found" }, 404);
    await match.handler(req, res, { params: match.params, url });
    return;
  }

  if (wantsCollab(url)) return proxyToCollab(req, res, url);

  if (vite) {
    // Vite owns /@vite/*, /@id/*, /src/*, module transforms, public files and
    // the SPA html fallback (appType: "spa").
    return vite.middlewares(req, res, () => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    });
  }

  await serveStatic(req, res, url);
}

// ---------------------------------------------------------------------------
// Collab service proxy (HTTP long-polling side of Socket.IO)
// ---------------------------------------------------------------------------
function proxyToCollab(req, res, url) {
  const proxyReq = httpRequest(
    {
      host: COLLAB_HOST,
      port: COLLAB_PORT,
      method: req.method,
      path: url.pathname + url.search,
      headers: { ...req.headers, host: `${COLLAB_HOST}:${COLLAB_PORT}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("collaboration service unavailable");
  });
  req.pipe(proxyReq);
}

// ---------------------------------------------------------------------------
// Static file serving (production)
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Method not allowed");
  }

  const decoded = safeDecode(url.pathname);
  if (decoded === null) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Bad request");
  }
  const target = resolvedPath(decoded);
  if (target && (await sendFile(req, res, target, url.pathname))) return;

  // SPA fallback: every unknown non-asset path renders the app shell. The app
  // itself is a single route (`/`, optionally with ?w=<workspaceId>).
  if (!path.extname(decoded)) return sendFile(req, res, path.join(DIST, "index.html"), "/");
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function resolvedPath(pathname) {
  const rel = pathname.replace(/^\/+/, "");
  if (!rel) return path.join(DIST, "index.html");
  const full = path.resolve(DIST, rel);
  // path traversal guard — never escape the build output directory
  return full === DIST || full.startsWith(DIST + path.sep) ? full : null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function sendFile(req, res, filePath, urlPath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(filePath).toLowerCase();
  const immutable = urlPath.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "last-modified": stat.mtime.toUTCString(),
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
  return true;
}

httpServer.listen(PORT, HOST, () => {
  console.log(
    `[server] listening on http://${HOST}:${PORT} (${isProd ? "production" : "development"})`
  );
});

// ---------------------------------------------------------------------------
// Localhost-only internal endpoint (collab service → web).
// The collaboration service posts events here (e.g. board comment mentions)
// so this process can fan them out to notifications and automation.
// ---------------------------------------------------------------------------
const WEB_INTERNAL_PORT = Number(process.env.WEB_INTERNAL_PORT || 3005);
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "iw-internal-token";

const internalServer = createServer((req, res) => {
  if (req.headers["x-internal-token"] !== INTERNAL_TOKEN) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "forbidden" }));
  }
  if (req.url !== "/internal/events") {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  }
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 1024 * 1024) return req.destroy();
    chunks.push(c);
  });
  req.on("end", async () => {
    let payload = {};
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid json" }));
    }
    try {
      if (payload.event === "comment.created") {
        await notifyCommentCreated({
          workspaceId: payload.workspaceId,
          actorId: payload.actorId || "",
          payload: payload.payload || {},
        });
      }
      await dispatchEvent({
        workspaceId: payload.workspaceId,
        event: payload.event,
        payload: payload.payload || {},
        actorId: payload.actorId || "",
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
  });
});
internalServer.listen(WEB_INTERNAL_PORT, "127.0.0.1", () => {
  console.log(`[server] internal events endpoint on http://127.0.0.1:${WEB_INTERNAL_PORT}`);
});

startAutomationWorker();

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown() {
  console.log("\n[server] shutting down");
  httpServer.close(() => process.exit(0));
  internalServer.close(() => {});
  setTimeout(() => process.exit(0), 2000).unref();
}