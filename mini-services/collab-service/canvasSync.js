// ============================================================
// Canvas synchronization engine (server side).
//
// Pipeline for every submitted operation:
//   validate → assign version (workspace monotonic counter, tx) →
//   apply to canvas_objects (materialized state) → append to operations log →
//   broadcast to room → maybe snapshot
//
// Guarantees:
//   - total-order broadcast: every client applies ops in version order
//   - convergence: identical op order + deterministic op semantics
//   - durability: op appended + state materialized in one transaction
// ============================================================

import { db, tx, nextVersion, getVersion } from "./db.js";
import {
  OP,
  validateCanvasOp,
  normalizeObjectPayload,
  SNAPSHOT_EVERY,
  CANVAS_SYNC_MAX_OPS,
} from "../../src/shared/protocol.js";

// ---------------------------------------------------------------------------
// Apply a single (already validated) op to the materialized canvas_objects row
// ---------------------------------------------------------------------------
function applyToRow(op, workspaceId, userId, version, now) {
  const { type, oid, p } = op;

  const loadPayload = () => {
    const row = db
      .prepare(
        "SELECT payload, type, z_index FROM canvas_objects WHERE id = ? AND workspace_id = ? AND deleted = 0"
      )
      .get(oid, workspaceId);
    if (!row) return null;
    return { row, payload: JSON.parse(row.payload) };
  };
  const savePayload = (payload, row) => {
    db.prepare(
      "UPDATE canvas_objects SET payload = ?, updated_at = ?, updated_version = ? WHERE id = ? AND workspace_id = ?"
    ).run(JSON.stringify(payload), now, version, oid, workspaceId);
  };

  switch (type) {
    case OP.CREATE: {
      const obj = p.object;
      // Upsert, not INSERT OR IGNORE: a CREATE may legally target an id whose
      // row still exists but is soft-deleted (undo of an eraser delete, or the
      // DELETE+CREATE pair a restore emits). INSERT OR IGNORE silently no-oped
      // there, leaving the materialized row dead while the op log said it
      // exists — clients then diverged from the server after reload.
      // On conflict keep the original created_by/created_at (historical truth).
      db.prepare(
        `INSERT INTO canvas_objects
         (id, workspace_id, type, payload, z_index, created_by, created_at, updated_at, updated_version, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           payload = excluded.payload,
           z_index = excluded.z_index,
           deleted = 0,
           updated_at = excluded.updated_at,
           updated_version = excluded.updated_version`
      ).run(
        oid,
        workspaceId,
        obj.type,
        JSON.stringify(obj.payload),
        obj.z || 0,
        obj.createdBy || userId,
        now,
        now,
        version
      );
      return;
    }
    case OP.DELETE:
      db.prepare(
        "UPDATE canvas_objects SET deleted = 1, updated_at = ?, updated_version = ? WHERE id = ? AND workspace_id = ?"
      ).run(now, version, oid, workspaceId);
      return;
    case OP.MOVE:
    case OP.RESIZE:
    case OP.ROTATE:
    case OP.STYLE:
    case OP.TEXT: {
      const loaded = loadPayload();
      if (!loaded) return;
      const payload = loaded.payload;
      if (type === OP.MOVE) {
        payload.x += p.dx;
        payload.y += p.dy;
        if (payload.data && typeof payload.data.x2 === "number") payload.data.x2 += p.dx;
        if (payload.data && typeof payload.data.y2 === "number") payload.data.y2 += p.dy;
        if (payload.data && Array.isArray(payload.data.fromPt)) {
          payload.data.fromPt[0] += p.dx;
          payload.data.fromPt[1] += p.dy;
        }
        if (payload.data && Array.isArray(payload.data.toPt)) {
          payload.data.toPt[0] += p.dx;
          payload.data.toPt[1] += p.dy;
        }
      } else if (type === OP.RESIZE) {
        if (loaded.row.type === "line" || loaded.row.type === "arrow") {
          const old = payload;
          const x2 = old.data?.x2 ?? old.x + old.w;
          const y2 = old.data?.y2 ?? old.y + old.h;
          const relX = old.w ? (x2 - old.x) / old.w : 1;
          const relY = old.h ? (y2 - old.y) / old.h : 1;
          payload.data.x2 = p.x + relX * p.w;
          payload.data.y2 = p.y + relY * p.h;
        }
        if (
          (loaded.row.type === "freehand" || loaded.row.type === "text" || loaded.row.type === "sticky") &&
          payload.w &&
          payload.h
        ) {
          const sx = p.w / payload.w;
          const sy = p.h / payload.h;
          if (loaded.row.type === "freehand" && Array.isArray(payload.data?.points)) {
            payload.data.points = payload.data.points.map(([dx, dy]) => [dx * sx, dy * sy]);
          }
          if (payload.style && typeof payload.style.fontSize === "number" && loaded.row.type !== "freehand") {
            payload.style.fontSize = Math.max(6, Math.round(payload.style.fontSize * ((sy + sx) / 2)));
          }
        }
        payload.x = p.x;
        payload.y = p.y;
        payload.w = p.w;
        payload.h = p.h;
      } else if (type === OP.ROTATE) {
        payload.rot = p.rot;
      } else if (type === OP.STYLE) {
        payload.style = { ...(payload.style || {}), ...p.style };
      } else if (type === OP.TEXT) {
        if (payload.data) payload.data.text = p.text;
      }
      savePayload(payload);
      return;
    }
    case OP.ZORDER:
      db.prepare(
        "UPDATE canvas_objects SET z_index = ?, updated_at = ?, updated_version = ? WHERE id = ? AND workspace_id = ?"
      ).run(p.z, now, version, oid, workspaceId);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Process a batch of ops from one socket. Returns acks/errors per op.
// ---------------------------------------------------------------------------
export function processCanvasOps(io, socket, room, ops) {
  const results = [];
  const applied = [];

  for (const raw of ops) {
    const v = validateCanvasOp(raw);
    if (!v.ok) {
      results.push({ id: raw?.id || null, ok: false, error: v.error });
      continue;
    }
    const op = v.op;
    const now = Date.now();
    const clientId = typeof raw?.id === "string" ? raw.id.slice(0, 64) : "";
    try {
      const version = tx(() => nextVersion(room));
      applyToRow(op, room, socket.data.userId, version, now);
      db.prepare(
        "INSERT INTO operations (workspace_id, user_id, type, object_id, payload, version, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(room, socket.data.userId, op.type, op.oid, JSON.stringify(op.p), version, clientId, now);
      db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(now, room);

      results.push({ id: raw?.id || null, ok: true, version });
      applied.push({ op, version });
    } catch (err) {
      console.error("[canvas] apply failed:", err.message);
      results.push({ id: raw?.id || null, ok: false, error: "apply failed" });
    }
  }

  // ack sender
  if (results.length) socket.emit("canvas:ack", { results });

  // broadcast applied ops to everyone else in the room
  for (const { op, version } of applied) {
    io.to(`ws:${room}`).emit("canvas:op", {
      op: { type: op.type, oid: op.oid, p: op.p },
      version,
      by: socket.data.userId,
    });
  }

  // periodic snapshot (sync fn — never let it throw into the timer)
  const lastVersion = applied.length ? applied[applied.length - 1].version : null;
  if (lastVersion && lastVersion % SNAPSHOT_EVERY === 0) {
    setTimeout(() => {
      try {
        takeSnapshot(room, lastVersion);
      } catch (err) {
        console.error("[canvas] snapshot failed:", err.message);
      }
    }, 50);
  }
  return lastVersion;
}

// ---------------------------------------------------------------------------
// Sync: give a lagging/offline client everything it missed since `since`
// ---------------------------------------------------------------------------
export function buildSyncResponse(room, since) {
  const version = getVersion(room);
  if (version - since > CANVAS_SYNC_MAX_OPS) {
    // too far behind → full state refresh
    const objects = db
      .prepare(
        "SELECT id, type, payload, z_index, created_by FROM canvas_objects WHERE workspace_id = ? AND deleted = 0"
      )
      .all(room);
    return {
      full: true,
      version,
      objects: objects.map(rowToRecord),
      ops: [],
    };
  }
  const rows = db
    .prepare(
      "SELECT type, object_id, payload, version, user_id, client_id FROM operations WHERE workspace_id = ? AND version > ? ORDER BY version ASC"
    )
    .all(room, since);
  const ops = rows.map((r) => ({
    version: r.version,
    type: r.type,
    oid: r.object_id,
    p: JSON.parse(r.payload),
    userId: r.user_id,
    clientId: r.client_id || null,
  }));

  // Server-side current state of every object touched by the missed range —
  // lets an offline client reconcile by wholesale replacement (no replay).
  const touched = [...new Set(rows.map((r) => r.object_id))].filter(Boolean);
  const objects = [];
  if (touched.length) {
    const placeholders = touched.map(() => "?").join(",");
    const objRows = db
      .prepare(
        `SELECT id, type, payload, z_index, created_by, deleted FROM canvas_objects
         WHERE workspace_id = ? AND id IN (${placeholders})`
      )
      .all(room, ...touched);
    const seen = new Set();
    for (const row of objRows) {
      objects.push({ ...rowToRecord(row), deleted: !!row.deleted });
      seen.add(row.id);
    }
    for (const id of touched) {
      if (!seen.has(id)) objects.push({ id, deleted: true });
    }
  }

  return { full: false, version, ops, objects };
}

function rowToRecord(row) {
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload),
    z: row.z_index,
    createdBy: row.created_by,
  };
}

// ---------------------------------------------------------------------------
// Snapshots (event sourcing: state = snapshot + replay of later ops)
// ---------------------------------------------------------------------------
export function takeSnapshot(room, version) {
  const objects = db
    .prepare(
      "SELECT id, type, payload, z_index, created_by FROM canvas_objects WHERE workspace_id = ? AND deleted = 0"
    )
    .all(room);
  const docs = db
    .prepare("SELECT id, content FROM documents WHERE workspace_id = ? AND deleted = 0 AND is_folder = 0")
    .all(room);
  const state = {
    objects: objects.map(rowToRecord),
    docs: Object.fromEntries(docs.map((d) => [d.id, d.content])),
  };
  db.prepare(
    "INSERT INTO snapshots (workspace_id, version, state, created_at) VALUES (?, ?, ?, ?)"
  ).run(room, version, JSON.stringify(state), Date.now());
  db.prepare(
    "UPDATE workspace_state SET snapshot_version = ? WHERE workspace_id = ?"
  ).run(version, room);
  // keep the last 20 snapshots per workspace
  db.prepare(
    `DELETE FROM snapshots WHERE workspace_id = ? AND version < ? AND id NOT IN (
       SELECT id FROM snapshots WHERE workspace_id = ? ORDER BY version DESC LIMIT 19)`
  ).run(room, version, room);
}

// ---------------------------------------------------------------------------
// Restore: compute state@version, diff vs current, emit difference as ops
// ---------------------------------------------------------------------------
export function restoreToVersion(io, room, version, userId, userName) {
  const current = getVersion(room);
  if (!isFinite(version) || version < 0 || version > current)
    return { ok: false, error: "Version out of range" };

  // 1. latest snapshot ≤ version
  const snap = db
    .prepare(
      "SELECT version, state FROM snapshots WHERE workspace_id = ? AND version <= ? ORDER BY version DESC LIMIT 1"
    )
    .get(room, version);

  const objectsAt = new Map(); // id → record
  let replayFrom = 1;
  if (snap) {
    const state = JSON.parse(snap.state);
    for (const o of state.objects) objectsAt.set(o.id, o);
    replayFrom = snap.version + 1;
  }

  // 2. replay ops (snapshot_version+1 … version)
  const rows = db
    .prepare(
      "SELECT type, object_id, payload, user_id FROM operations WHERE workspace_id = ? AND version >= ? AND version <= ? ORDER BY version ASC"
    )
    .all(room, replayFrom, version);
  for (const r of rows) {
    const op = { type: r.type, oid: r.object_id, p: JSON.parse(r.payload) };
    const id = op.oid;
    if (op.type === OP.CREATE) {
      objectsAt.set(id, {
        id,
        type: op.p.object.type,
        payload: op.p.object.payload,
        z: op.p.object.z || 0,
        createdBy: r.user_id,
      });
    } else if (op.type === OP.DELETE) {
      objectsAt.delete(id);
    } else {
      const o = objectsAt.get(id);
      if (!o) continue;
      applyOpToRecord(o, op);
    }
  }

  // 3. current live state
  const liveRows = db
    .prepare(
      "SELECT id, type, payload, z_index, created_by FROM canvas_objects WHERE workspace_id = ? AND deleted = 0"
    )
    .all(room);
  const live = new Map(liveRows.map((r) => [r.id, rowToRecord(r)]));

  // 4. diff: force current → state@version
  const ops = [];
  const push = (type, oid, p) => ops.push({ id: `rst_${Math.random().toString(36).slice(2, 10)}`, type, oid, p });

  for (const [id, rec] of objectsAt) {
    const cur = live.get(id);
    if (!cur || JSON.stringify(stripMeta(cur)) !== JSON.stringify(stripMeta(rec))) {
      push(OP.DELETE, id, {});
      push(OP.CREATE, id, {
        object: {
          id,
          type: rec.type,
          payload: rec.payload,
          z: rec.z,
          createdBy: rec.createdBy || userId,
        },
      });
    }
  }
  for (const id of live.keys()) {
    if (!objectsAt.has(id)) push(OP.DELETE, id, {});
  }

  if (!ops.length) return { ok: true, restored: version, opsApplied: 0 };
  if (ops.length > 5000) return { ok: false, error: "Diff too large to restore" };

  processCanvasOps(io, { data: { userId }, emit: () => {} }, room, ops);
  return { ok: true, restored: version, opsApplied: ops.length, by: userName };
}

function stripMeta(rec) {
  return { type: rec.type, payload: rec.payload, z: rec.z };
}

// apply an op to a plain in-memory record (for restore replay)
function applyOpToRecord(o, op) {
  const p = o.payload;
  switch (op.type) {
    case OP.MOVE:
      p.x += op.p.dx;
      p.y += op.p.dy;
      if (p.data && typeof p.data.x2 === "number") p.data.x2 += op.p.dx;
      if (p.data && typeof p.data.y2 === "number") p.data.y2 += op.p.dy;
      if (p.data && Array.isArray(p.data.fromPt)) {
        p.data.fromPt[0] += op.p.dx;
        p.data.fromPt[1] += op.p.dy;
      }
      if (p.data && Array.isArray(p.data.toPt)) {
        p.data.toPt[0] += op.p.dx;
        p.data.toPt[1] += op.p.dy;
      }
      break;
    case OP.RESIZE:
      p.x = op.p.x;
      p.y = op.p.y;
      p.w = op.p.w;
      p.h = op.p.h;
      break;
    case OP.ROTATE:
      p.rot = op.p.rot;
      break;
    case OP.STYLE:
      p.style = { ...(p.style || {}), ...op.p.style };
      break;
    case OP.TEXT:
      if (p.data) p.data.text = op.p.text;
      break;
    case OP.ZORDER:
      o.z = op.p.z;
      break;
    default:
      break;
  }
}

// materialize a CREATE payload coming from a snapshot record
export { normalizeObjectPayload };
