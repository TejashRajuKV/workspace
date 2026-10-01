// Inverse-operation builders for per-user undo/redo.
//
// In a collaborative system you cannot "remove the last global operation" —
// another user's op may sit on top of yours. Instead, undo submits the INVERSE
// of your own operation as a brand-new (versioned, broadcast) operation:
//   create ↔ delete, move(+d) ↔ move(−d), absolute setters restore old values.
//
// buildHistoryEntry must be called with the object state BEFORE the op is
// applied. Returns { apply, inverse } or null.

import { OP } from "@/shared/protocol";
import { cloneObject } from "@/shared/canvasOps";
import { hitTestObject } from "./geometry";

export function buildHistoryEntry(objects, op) {
  switch (op.type) {
    case OP.CREATE: {
      const id = op.oid;
      return {
        apply: op,
        inverse: { type: OP.DELETE, oid: id, p: {} },
      };
    }
    case OP.DELETE: {
      const rec = objects.get(op.oid);
      if (!rec) return null;
      const clone = cloneObject(rec);
      return {
        apply: op,
        inverse: {
          type: OP.CREATE,
          oid: op.oid,
          p: { object: { id: clone.id, type: clone.type, payload: clone.payload, z: clone.z } },
        },
      };
    }
    case OP.MOVE:
      return {
        apply: op,
        inverse: { type: OP.MOVE, oid: op.oid, p: { dx: -op.p.dx, dy: -op.p.dy } },
      };
    case OP.RESIZE: {
      const rec = objects.get(op.oid);
      if (!rec) return null;
      const p = rec.payload;
      return {
        apply: op,
        inverse: { type: OP.RESIZE, oid: op.oid, p: { x: p.x, y: p.y, w: p.w, h: p.h } },
      };
    }
    case OP.ROTATE: {
      const rec = objects.get(op.oid);
      if (!rec) return null;
      return {
        apply: op,
        inverse: { type: OP.ROTATE, oid: op.oid, p: { rot: rec.payload.rot || 0 } },
      };
    }
    case OP.STYLE: {
      const rec = objects.get(op.oid);
      if (!rec) return null;
      return {
        apply: op,
        inverse: { type: OP.STYLE, oid: op.oid, p: { style: cloneObject(rec).payload.style } },
      };
    }
    case OP.TEXT: {
      const rec = objects.get(op.oid);
      if (!rec) return null;
      return {
        apply: op,
        inverse: { type: OP.TEXT, oid: op.oid, p: { text: rec.payload.data?.text ?? "" } },
      };
    }
    case OP.ZORDER: {
      const rec = objects.get(op.oid);
      if (!rec) return null;
      return {
        apply: op,
        inverse: { type: OP.ZORDER, oid: op.oid, p: { z: rec.z } },
      };
    }
    default:
      return null;
  }
}

// Top-most hit at a world point: candidates sorted by z descending.
export function pickTopmost(candidates, objects, wx, wy, tol) {
  const hits = [];
  for (const id of candidates) {
    const obj = objects.get(id);
    if (!obj) continue;
    hits.push(obj);
  }
  hits.sort((a, b) => (b.z || 0) - (a.z || 0));
  for (const obj of hits) {
    if (hitTestObject(obj, wx, wy, tol, objects)) return obj;
  }
  return null;
}
