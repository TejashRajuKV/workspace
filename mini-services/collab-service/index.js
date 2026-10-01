// ============================================================
// Collaboration service — Socket.IO server (port 3003).
//
// Reached by browsers through the gateway as:  io('/?XTransformPort=3003')
// Reached by the Next.js server internally as: http://127.0.0.1:3003/internal/*
//
// Identity: the session token arrives in handshake.auth.token and is verified
// against the sessions table. The client NEVER gets to claim a userId.
// ============================================================

import { createServer } from "node:http";
import { Server } from "socket.io";
import {
  db,
  getSessionUser,
  getRole,
  workspaceExists,
} from "./db.js";
import {
  processCanvasOps,
  buildSyncResponse,
  restoreToVersion,
} from "./canvasSync.js";
import {
  submitDocOp,
  syncDoc,
  getDocState,
  openDoc,
  invalidateDoc,
} from "./docSync.js";
import {
  bindPresence,
  joinPresence,
  leavePresence,
  updatePresence,
  presenceSnapshot,
} from "./presence.js";
import { startExecution } from "./execution.js";
import { LIMITS, opSummary } from "../../src/shared/protocol.js";

const PORT = 3003;
const INTERNAL_PORT = 3004; // localhost-only, for the Next.js server
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "iw-internal-token";

const httpServer = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "collab" }));
});

// Internal endpoints run on a separate localhost-only listener because the
// socket.io server (path "/") claims every request on the main port.
const internalServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 1e6) req.destroy();
  });
  req.on("end", () => {
    if (req.headers["x-internal-token"] !== INTERNAL_TOKEN) {
      res.writeHead(403).end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    handleInternal(req, body)
      .then((data) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      });
  });
});

async function handleInternal(req, body) {
  const payload = body ? JSON.parse(body || "{}") : {};
  if (req.url === "/internal/health") {
    return { ok: true, uptime: process.uptime(), ws: presenceSnapshot("probe").length };
  }
  if (req.url === "/internal/fs-changed") {
    const { workspaceId, kind } = payload;
    if (!workspaceId) throw new Error("workspaceId required");
    // file CRUD via REST → invalidate OT caches + tell clients to refresh tree
    const rows = db
      .prepare("SELECT id FROM documents WHERE workspace_id = ? AND deleted = 1 AND updated_at > ?")
      .all(workspaceId, Date.now() - 5000);
    for (const r of rows) invalidateDoc(r.id);
    io.to(`ws:${workspaceId}`).emit("fs:changed", { kind: kind || "changed" });
    return { ok: true };
  }
  if (req.url === "/internal/restore") {
    const { workspaceId, version, byUserId, byName } = payload;
    if (!workspaceId || !workspaceExists(workspaceId))
      throw new Error("workspace not found");
    const result = restoreToVersion(io, workspaceId, version, byUserId || "system", byName || "system");
    if (!result.ok) return result;
    io.to(`ws:${workspaceId}`).emit("ws:restored", {
      toVersion: version,
      by: byName || "system",
      opsApplied: result.opsApplied,
    });
    return result;
  }
  throw new Error("unknown internal endpoint");
}

const io = new Server(httpServer, {
  // DO NOT change the path — the gateway forwards exactly this path.
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,
});

bindPresence(io);

// ---------------------------------------------------------------------------
// socket auth middleware — identity comes ONLY from the session table.
// The token arrives either via handshake.auth.token or the httpOnly session
// cookie (same-origin WebSocket upgrades always carry cookies).
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  let token = socket.handshake.auth?.token;
  if (!token && socket.handshake.headers?.cookie) {
    const m = /(?:^|;\s*)iw_session=([^;]+)/.exec(socket.handshake.headers.cookie);
    if (m) token = decodeURIComponent(m[1]);
  }
  const user = getSessionUser(token);
  if (!user) return next(new Error("unauthorized"));
  socket.data.userId = user.id;
  socket.data.username = user.username;
  socket.data.color = user.color;
  socket.data.rate = makeRateLimiter();
  next();
});

function makeRateLimiter() {
  // token bucket: burst 2s worth, sustained rate
  return {
    canvas: { tokens: LIMITS.CANVAS_OP_RATE, last: Date.now(), rate: LIMITS.CANVAS_OP_RATE },
    doc: { tokens: LIMITS.DOC_OP_RATE, last: Date.now(), rate: LIMITS.DOC_OP_RATE },
    presence: { tokens: 40, last: Date.now(), rate: 20 },
  };
}

function consume(limiter, kind, cost = 1) {
  const b = limiter[kind];
  const now = Date.now();
  b.tokens = Math.min(b.rate * 2, b.tokens + ((now - b.last) / 1000) * b.rate);
  b.last = now;
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}

io.on("connection", (socket) => {
  let joinedRoom = null;

  socket.on("ws:join", ({ workspaceId } = {}, cb) => {
    try {
      if (!workspaceId || typeof workspaceId !== "string" || workspaceId.length > 64)
        return ack(cb, { error: "bad workspaceId" });
      const role = getRole(workspaceId, socket.data.userId);
      if (!role || !workspaceExists(workspaceId))
        return ack(cb, { error: "Workspace not found or access denied" });

      if (joinedRoom) {
        socket.leave(`ws:${joinedRoom}`);
        leavePresence(`ws:${joinedRoom}`, socket.id);
      }
      joinedRoom = workspaceId;
      socket.join(`ws:${workspaceId}`);
      joinPresence(`ws:${workspaceId}`, socket.id, {
        id: socket.data.userId,
        username: socket.data.username,
        color: socket.data.color,
      });

      const version = getVersionSafe(workspaceId);
      const objects = db
        .prepare(
          "SELECT id, type, payload, z_index, created_by FROM canvas_objects WHERE workspace_id = ? AND deleted = 0"
        )
        .all(workspaceId)
        .map((r) => ({
          id: r.id,
          type: r.type,
          payload: JSON.parse(r.payload),
          z: r.z_index,
          createdBy: r.created_by,
        }));
      const docs = db
        .prepare(
          "SELECT id, path, is_folder, content, doc_version FROM documents WHERE workspace_id = ? AND deleted = 0 ORDER BY path"
        )
        .all(workspaceId);
      const memberRows = db
        .prepare(
          `SELECT m.user_id, m.role FROM workspace_members m WHERE m.workspace_id = ?`
        )
        .all(workspaceId);
      const userRows = db
        .prepare(
          `SELECT id, username, color FROM users WHERE id IN (${memberRows.map(() => "?").join(",") || "''"})`
        )
        .all(...memberRows.map((m) => m.user_id));
      const userMap = Object.fromEntries(userRows.map((u) => [u.id, u]));
      const members = memberRows.map((m) => ({
        user: userMap[m.user_id] || { id: m.user_id, username: "unknown", color: "#888" },
        role: m.role,
      }));

      ack(cb, {
        version,
        objects,
        docs,
        role,
        members,
        peers: presenceSnapshot(`ws:${workspaceId}`),
        you: { id: socket.data.userId, username: socket.data.username, color: socket.data.color },
      });
      socket.to(`ws:${workspaceId}`).emit("presence:joined", {
        user: { id: socket.data.userId, username: socket.data.username, color: socket.data.color },
      });
    } catch (err) {
      ack(cb, { error: String(err?.message || err) });
    }
  });

  socket.on("ws:leave", () => {
    if (joinedRoom) {
      socket.leave(`ws:${joinedRoom}`);
      leavePresence(`ws:${joinedRoom}`, socket.id);
      joinedRoom = null;
    }
  });

  // ---------------- canvas operations ----------------
  socket.on("canvas:op", ({ ops } = {}, cb) => {
    if (!joinedRoom) return ack(cb, { error: "join a workspace first" });
    const role = getRole(joinedRoom, socket.data.userId);
    if (role !== "owner" && role !== "editor")
      return ack(cb, { error: "viewers cannot edit" });
    if (!consume(socket.data.rate, "canvas", Math.min(Array.isArray(ops) ? ops.length : 1, 10)))
      return ack(cb, { error: "rate limited" });
    const list = Array.isArray(ops) ? ops.slice(0, LIMITS.MAX_OPS_BATCH) : [];
    if (!list.length) return ack(cb, { error: "no ops" });
    const lastVersion = processCanvasOps(io, socket, joinedRoom, list);
    ack(cb, { ok: true, version: lastVersion });
  });

  socket.on("sync:request", ({ since } = {}, cb) => {
    if (!joinedRoom) return ack(cb, { error: "join a workspace first" });
    if (typeof since !== "number" || !isFinite(since))
      return ack(cb, { error: "bad since" });
    ack(cb, buildSyncResponse(joinedRoom, since));
  });

  // ---------------- documents ----------------
  socket.on("doc:open", ({ documentId } = {}, cb) => {
    if (!joinedRoom) return ack(cb, { error: "join a workspace first" });
    if (typeof documentId !== "string") return ack(cb, { error: "bad documentId" });
    openDoc(socket, documentId, (res) => ack(cb, res));
  });

  socket.on("doc:op", ({ documentId, op, rev } = {}, cb) => {
    if (!joinedRoom) return ack(cb, { error: "join a workspace first" });
    const role = getRole(joinedRoom, socket.data.userId);
    if (role !== "owner" && role !== "editor")
      return ack(cb, { error: "viewers cannot edit" });
    if (!consume(socket.data.rate, "doc")) return ack(cb, { error: "rate limited" });
    const res = submitDocOp(io, socket, joinedRoom, documentId, op, rev);
    ack(cb, res);
  });

  socket.on("doc:sync", ({ documentId, since } = {}, cb) => {
    if (!joinedRoom) return ack(cb, { error: "join a workspace first" });
    if (typeof documentId !== "string") return ack(cb, { error: "bad documentId" });
    ack(cb, syncDoc(documentId, since));
  });

  socket.on("doc:state", ({ documentId } = {}, cb) => {
    if (!joinedRoom) return ack(cb, { error: "join a workspace first" });
    const s = getDocState(documentId);
    ack(cb, s || { error: "not found" });
  });

  // ---------------- presence ----------------
  socket.on("presence:update", (patch = {}) => {
    if (!joinedRoom) return;
    if (!consume(socket.data.rate, "presence")) return;
    const clean = {};
    if (patch.cursor === null) clean.cursor = null;
    else if (
      patch.cursor &&
      typeof patch.cursor.x === "number" &&
      typeof patch.cursor.y === "number" &&
      isFinite(patch.cursor.x) &&
      isFinite(patch.cursor.y)
    )
      clean.cursor = { x: patch.cursor.x, y: patch.cursor.y };
    if (Array.isArray(patch.selection)) clean.selection = patch.selection.slice(0, 500);
    if (patch.view === "board" || patch.view === "code") clean.view = patch.view;
    if (patch.editor === null) clean.editor = null;
    else if (patch.editor && typeof patch.editor.fileId === "string")
      clean.editor = {
        fileId: patch.editor.fileId.slice(0, 64),
        offset: typeof patch.editor.offset === "number" ? patch.editor.offset : 0,
        anchor: typeof patch.editor.anchor === "number" ? patch.editor.anchor : 0,
      };
    updatePresence(`ws:${joinedRoom}`, socket.id, clean);
  });

  // ---------------- execution ----------------
  socket.on("exec:start", ({ fileId, language } = {}, cb) => {
    if (!joinedRoom) return ack(cb, { error: "join a workspace first" });
    const role = getRole(joinedRoom, socket.data.userId);
    if (role !== "owner" && role !== "editor")
      return ack(cb, { error: "viewers cannot run code" });
    if (typeof fileId !== "string") return ack(cb, { error: "bad fileId" });
    const res = startExecution(io, socket, joinedRoom, { fileId, language });
    ack(cb, res);
  });

  socket.on("disconnect", () => {
    if (joinedRoom) leavePresence(`ws:${joinedRoom}`, socket.id);
  });

  socket.on("error", (err) => console.error("[socket]", err.message));
});

function getVersionSafe(workspaceId) {
  const row = db
    .prepare("SELECT version FROM workspace_state WHERE workspace_id = ?")
    .get(workspaceId);
  return row ? row.version : 0;
}

function ack(cb, data) {
  if (typeof cb === "function") {
    try {
      cb(data);
    } catch {}
  }
}

httpServer.listen(PORT, () => {
  console.log(`[collab-service] listening on :${PORT} (socket.io path "/")`);
});

internalServer.listen(INTERNAL_PORT, "127.0.0.1", () => {
  console.log(`[collab-service] internal endpoints on 127.0.0.1:${INTERNAL_PORT}`);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
