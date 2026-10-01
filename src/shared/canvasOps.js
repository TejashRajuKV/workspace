// ============================================================
// Shared canvas-object logic — used by BOTH the browser client and the
// collaboration service (pure JS, no DOM).
//
// Canvas synchronization strategy (documented in docs/synchronization.md):
//   1. The service assigns every operation a per-workspace monotonically
//      increasing `version` → total-order broadcast. All clients apply ops
//      in that order → deterministic convergence (state replication).
//   2. MOVE operations carry COMMUTATIVE deltas (dx, dy): concurrent moves
//      of the same object merge additively instead of overwriting.
//   3. All other operations carry absolute values; the last op in server
//      order wins (deterministic LWW).
//   4. Offline rebase rule (client-side, mergeReconnect):
//        - apply missed remote ops in server order
//        - then re-apply own pending ops in order, EXCEPT own MOVE deltas
//          (already part of the local sum; re-applying would double-count)
//      This reproduces exactly the server's canonical state.
// ============================================================

import { OP, LIMITS } from "./protocol.js";

export function makeStyle(overrides = {}) {
  return {
    fill: "#dbe4f0",
    stroke: "#31405c",
    strokeWidth: 2,
    opacity: 1,
    fontSize: 16,
    color: "#1c2433",
    align: "center",
    ...overrides,
  };
}

// Clone a live object record (deep enough for payload mutations).
export function cloneObject(obj) {
  return {
    id: obj.id,
    type: obj.type,
    z: obj.z,
    payload: JSON.parse(JSON.stringify(obj.payload)),
    createdBy: obj.createdBy,
  };
}

// World-space AABB of an object, rotation-aware. Used for the spatial index
// (broad phase). Precise hit-testing happens in the client's hittest module.
export function objectBounds(obj) {
  const p = obj.payload;
  let bx = p.x,
    by = p.y,
    bw = p.w,
    bh = p.h;
  if (obj.type === "line" || obj.type === "arrow") {
    const x2 = p.data?.x2 ?? p.x + p.w;
    const y2 = p.data?.y2 ?? p.y + p.h;
    bx = Math.min(p.x, x2);
    by = Math.min(p.y, y2);
    bw = Math.abs(x2 - p.x) || 1;
    bh = Math.abs(y2 - p.y) || 1;
  } else if (obj.type === "freehand") {
    const pts = p.data?.points || [];
    let minX = 0,
      minY = 0,
      maxX = 0,
      maxY = 0;
    for (const [dx, dy] of pts) {
      if (dx < minX) minX = dx;
      if (dy < minY) minY = dy;
      if (dx > maxX) maxX = dx;
      if (dy > maxY) maxY = dy;
    }
    bx = p.x + minX;
    by = p.y + minY;
    bw = Math.max(maxX - minX, 1);
    bh = Math.max(maxY - minY, 1);
  } else if (obj.type === "connector") {
    // endpoints resolved at render time from referenced objects; bounds are
    // kept loose (fromPt/toPt or full-world fallback handled by renderer)
    const fp = p.data?.fromPt,
      tp = p.data?.toPt;
    if (fp && tp) {
      bx = Math.min(fp[0], tp[0]);
      by = Math.min(fp[1], tp[1]);
      bw = Math.abs(tp[0] - fp[0]) || 1;
      bh = Math.abs(tp[1] - fp[1]) || 1;
    }
  }
  if (!p.rot) return { x: bx, y: by, w: bw, h: bh };
  // AABB of the rotated rectangle around its center
  const cx = bx + bw / 2,
    cy = by + bh / 2;
  const cos = Math.abs(Math.cos(p.rot));
  const sin = Math.abs(Math.sin(p.rot));
  const rw = bw * cos + bh * sin;
  const rh = bw * sin + bh * cos;
  return { x: cx - rw / 2, y: cy - rh / 2, w: rw, h: rh };
}

// Apply one operation to an in-memory objects Map (id → object record).
// Mutates the map. `now` (ms) is stored as updatedAt. Returns true if applied.
export function applyCanvasOp(objects, op, userId, now = Date.now()) {
  const { type, oid, p } = op;
  const obj = objects.get(oid);

  switch (type) {
    case OP.CREATE: {
      if (obj) return false; // create is idempotent-per-id
      const created = {
        id: oid,
        type: p.object.type,
        z: typeof p.object.z === "number" ? p.object.z : 0,
        payload: p.object.payload,
        createdBy: userId,
      };
      objects.set(oid, created);
      return true;
    }
    case OP.DELETE:
      if (!obj) return false;
      objects.delete(oid);
      return true;
    case OP.MOVE: {
      if (!obj) return false;
      const pl = obj.payload;
      pl.x += p.dx;
      pl.y += p.dy;
      // free endpoints (line/arrow) move with the object
      if (pl.data && typeof pl.data.x2 === "number") pl.data.x2 += p.dx;
      if (pl.data && typeof pl.data.y2 === "number") pl.data.y2 += p.dy;
      if (pl.data && Array.isArray(pl.data.fromPt)) {
        pl.data.fromPt[0] += p.dx;
        pl.data.fromPt[1] += p.dy;
      }
      if (pl.data && Array.isArray(pl.data.toPt)) {
        pl.data.toPt[0] += p.dx;
        pl.data.toPt[1] += p.dy;
      }
      obj.updatedAt = now;
      return true;
    }
    case OP.RESIZE: {
      if (!obj) return false;
      const old = obj.payload;
      // keep line/arrow endpoints proportionally inside the new rect
      if (obj.type === "line" || obj.type === "arrow") {
        const x2 = old.data?.x2 ?? old.x + old.w;
        const y2 = old.data?.y2 ?? old.y + old.h;
        const relX = old.w ? (x2 - old.x) / old.w : 1;
        const relY = old.h ? (y2 - old.y) / old.h : 1;
        old.data.x2 = p.x + relX * p.w;
        old.data.y2 = p.y + relY * p.h;
      }
      if ((obj.type === "freehand" || obj.type === "text" || obj.type === "sticky") && old.w && old.h) {
        const sx = p.w / old.w;
        const sy = p.h / old.h;
        if (obj.type === "freehand" && Array.isArray(old.data?.points)) {
          old.data.points = old.data.points.map(([dx, dy]) => [dx * sx, dy * sy]);
        }
        if (old.style && typeof old.style.fontSize === "number" && obj.type !== "freehand") {
          old.style.fontSize = Math.max(6, Math.round(old.style.fontSize * ((sy + sx) / 2)));
        }
      }
      old.x = p.x;
      old.y = p.y;
      old.w = p.w;
      old.h = p.h;
      obj.updatedAt = now;
      return true;
    }
    case OP.ROTATE:
      if (!obj) return false;
      obj.payload.rot = p.rot;
      obj.updatedAt = now;
      return true;
    case OP.STYLE:
      if (!obj) return false;
      obj.payload.style = { ...obj.payload.style, ...p.style };
      obj.updatedAt = now;
      return true;
    case OP.TEXT:
      if (!obj) return false;
      if (obj.payload.data) obj.payload.data.text = p.text;
      obj.updatedAt = now;
      return true;
    case OP.ZORDER:
      if (!obj) return false;
      obj.z = p.z;
      obj.updatedAt = now;
      return true;
    default:
      return false;
  }
}

// Which object fields an op type overwrites absolutely (used by rebase).
export function isAbsoluteOp(type) {
  return type !== OP.MOVE;
}

// Offline-reconnect merge (runs ONLY on the client):
//   1. apply missed remote ops in server order
//   2. re-apply own pending ops in order, except own MOVE deltas
//   3. drop refs to objects that ended up deleted server-side
export function mergeReconnect(objects, missedRemoteOps, ownPendingOps, myUserId, now = Date.now()) {
  for (const op of missedRemoteOps) {
    applyCanvasOp(objects, op, op.userId || "remote", now);
  }
  for (const op of ownPendingOps) {
    if (op.type === OP.MOVE) continue; // additive & already in local sum
    applyCanvasOp(objects, op, myUserId, now);
  }
}

// Summarize a workspace's current state for a snapshot.
export function snapshotState(objects, docs) {
  return {
    objects: Array.from(objects.values()).map((o) => ({
      id: o.id,
      type: o.type,
      z: o.z,
      payload: o.payload,
      createdBy: o.createdBy,
    })),
    docs,
  };
}

export { LIMITS };
