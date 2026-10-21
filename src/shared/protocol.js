// ============================================================
// Shared protocol constants + validation
// Used by: browser client, Node.js REST API, collaboration service
// ============================================================

// Canvas operation types. Every operation is a small, serializable intent —
// never "send the whole board".
export const OP = {
  CREATE: "create", // p: { object }
  DELETE: "delete", // p: {}
  MOVE: "move", // p: { dx, dy }              (commutative delta)
  RESIZE: "resize", // p: { x, y, w, h }          (absolute, object-local)
  ROTATE: "rotate", // p: { rot }                 (absolute radians)
  STYLE: "style", // p: { style }               (absolute full style)
  TEXT: "text", // p: { text }
  ZORDER: "zorder", // p: { z }
  COMMENT: "comment", // p: { action, entry?, text?, resolved? }
  GROUP: "group", // p: { groupId }              (absolute; "" = ungroup)
};

export const OBJECT_TYPES = [
  "rectangle",
  "ellipse",
  "line",
  "arrow",
  "freehand",
  "text",
  "sticky",
  "image",
  "connector",
  "comment",
  "frame",
];

// Server-side safety limits (validated on EVERY operation, never trusted)
export const LIMITS = {
  MAX_TEXT: 20000,
  MAX_POINTS: 4000,
  MAX_IMAGE_BYTES: 600 * 1024, // dataURL length
  MAX_PAYLOAD_JSON: 700 * 1024,
  MAX_STYLE_JSON: 4096,
  MAX_MOVE_DELTA: 100000,
  MAX_OBJECTS_PER_WS: 100000,
  MAX_OPS_BATCH: 50,
  MAX_TITLE: 120,
  MAX_PATH: 240,
  MAX_FILE_BYTES: 512 * 1024,
  MAX_THREAD_ENTRIES: 200,
  MAX_COMMENT_BODY: 4000,
  DOC_OP_RATE: 80, // per second per socket
  CANVAS_OP_RATE: 100, // per second per socket (burst allowed via bucket)
};

export const SNAPSHOT_EVERY = 100; // versions
export const CANVAS_SYNC_MAX_OPS = 2000; // beyond this → full state refresh
export const DOC_SYNC_MAX_OPS = 400; // beyond this → full content reset

export function opSummary(op) {
  const n = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);
  switch (op.type) {
    case OP.CREATE:
      return `created ${op.p?.object?.type || "object"}`;
    case OP.DELETE:
      return "deleted object";
    case OP.MOVE:
      return `moved (${n(op.p?.dx)}, ${n(op.p?.dy)})`;
    case OP.RESIZE:
      return "resized object";
    case OP.ROTATE:
      return `rotated ${n(((op.p?.rot || 0) * 180) / Math.PI)}°`;
    case OP.STYLE:
      return "changed style";
    case OP.TEXT:
      return "edited text";
    case OP.ZORDER:
      return "changed layer";
    case OP.COMMENT:
      return op.p?.action === "reply" ? "commented" : op.p?.action === "resolve" ? "resolved comment" : "edited comment";
    case OP.GROUP:
      return op.p?.groupId ? "grouped" : "ungrouped";
    default:
      return op.type;
  }
}

// Strict server-side validation of a client-submitted canvas operation.
// Returns { ok, op } with a sanitized op, or { ok: false, error }.
export function validateCanvasOp(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "bad op" };
  const type = raw.type;
  const p = raw.p;
  if (!type || !p || typeof p !== "object") return { ok: false, error: "bad op shape" };
  if (!Object.values(OP).includes(type)) return { ok: false, error: "unknown type" };

  const num = (v) => typeof v === "number" && isFinite(v);
  const objId = typeof raw.oid === "string" ? raw.oid.slice(0, 64) : null;

  switch (type) {
    case OP.CREATE: {
      const obj = p.object;
      if (!obj || typeof obj !== "object" || typeof obj.id !== "string")
        return { ok: false, error: "bad object" };
      if (!OBJECT_TYPES.includes(obj.type)) return { ok: false, error: "bad type" };
      // obj = { id, type, z, payload: {x,y,w,h,rot,style,data} } — normalization
      // expects the flat payload (plus type for data-shape handling). Passing the
      // nested object here silently reset every CREATE to x:0,y:0,w:100,h:100.
      const norm = normalizeObjectPayload({ type: obj.type, ...(obj.payload || {}) });
      if (!norm) return { ok: false, error: "bad payload" };
      const size = JSON.stringify(norm).length;
      if (size > LIMITS.MAX_PAYLOAD_JSON) return { ok: false, error: "payload too large" };
      return {
        ok: true,
        op: {
          type,
          oid: obj.id,
          p: {
            object: {
              id: obj.id,
              type: obj.type,
              z: typeof obj.z === "number" && isFinite(obj.z) ? Math.round(obj.z) : 0,
              payload: norm,
            },
          },
        },
      };
    }
    case OP.DELETE:
      if (!objId) return { ok: false, error: "bad oid" };
      return { ok: true, op: { type, oid: objId, p: {} } };
    case OP.MOVE: {
      if (!objId || !num(p.dx) || !num(p.dy)) return { ok: false, error: "bad delta" };
      if (Math.abs(p.dx) > LIMITS.MAX_MOVE_DELTA || Math.abs(p.dy) > LIMITS.MAX_MOVE_DELTA)
        return { ok: false, error: "delta too large" };
      return { ok: true, op: { type, oid: objId, p: { dx: p.dx, dy: p.dy } } };
    }
    case OP.RESIZE: {
      if (!objId || !num(p.x) || !num(p.y) || !num(p.w) || !num(p.h))
        return { ok: false, error: "bad rect" };
      const w = Math.min(Math.max(p.w, 1), 200000);
      const h = Math.min(Math.max(p.h, 1), 200000);
      return {
        ok: true,
        op: { type, oid: objId, p: { x: p.x, y: p.y, w, h } },
      };
    }
    case OP.ROTATE:
      if (!objId || !num(p.rot)) return { ok: false, error: "bad rot" };
      return { ok: true, op: { type, oid: objId, p: { rot: p.rot } } };
    case OP.STYLE: {
      if (!objId || !p.style || typeof p.style !== "object")
        return { ok: false, error: "bad style" };
      if (JSON.stringify(p.style).length > LIMITS.MAX_STYLE_JSON)
        return { ok: false, error: "style too large" };
      return { ok: true, op: { type, oid: objId, p: { style: sanitizeStyle(p.style) } } };
    }
    case OP.TEXT:
      if (!objId || typeof p.text !== "string") return { ok: false, error: "bad text" };
      if (p.text.length > LIMITS.MAX_TEXT) return { ok: false, error: "text too long" };
      return { ok: true, op: { type, oid: objId, p: { text: p.text } } };
    case OP.ZORDER:
      if (!objId || !num(p.z)) return { ok: false, error: "bad z" };
      return { ok: true, op: { type, oid: objId, p: { z: Math.round(p.z) } } };
    case OP.COMMENT: {
      if (!objId) return { ok: false, error: "bad oid" };
      if (p.action === "reply") {
        const entry = p.entry;
        if (!entry || typeof entry !== "object" || typeof entry.body !== "string")
          return { ok: false, error: "bad entry" };
        const body = entry.body.slice(0, LIMITS.MAX_COMMENT_BODY);
        if (!body.trim()) return { ok: false, error: "empty comment" };
        const id = typeof entry.id === "string" && entry.id ? entry.id.slice(0, 64) : newCommentEntryId();
        return {
          ok: true,
          op: { type, oid: objId, p: { action: "reply", entry: { id, body, at: Date.now() } } },
        };
      }
      if (p.action === "resolve")
        return { ok: true, op: { type, oid: objId, p: { action: "resolve", resolved: p.resolved === true } } };
      if (p.action === "edit") {
        if (typeof p.text !== "string") return { ok: false, error: "bad text" };
        if (p.text.length > LIMITS.MAX_COMMENT_BODY) return { ok: false, error: "comment too long" };
        return { ok: true, op: { type, oid: objId, p: { action: "edit", text: p.text } } };
      }
      return { ok: false, error: "bad action" };
    }
    case OP.GROUP:
      if (!objId) return { ok: false, error: "bad oid" };
      return {
        ok: true,
        op: { type, oid: objId, p: { groupId: typeof p.groupId === "string" ? p.groupId.slice(0, 64) : "" } },
      };
    default:
      return { ok: false, error: "unknown" };
  }
}

export function sanitizeStyle(style) {
  const out = {};
  const str = (v, max = 64) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const num = (v, min, max) =>
    typeof v === "number" && isFinite(v) ? Math.min(Math.max(v, min), max) : undefined;
  out.fill = str(style.fill, 32);
  out.stroke = str(style.stroke, 32);
  out.strokeWidth = num(style.strokeWidth, 0, 200);
  out.opacity = num(style.opacity, 0, 1);
  out.fontSize = num(style.fontSize, 6, 400);
  out.color = str(style.color, 32);
  out.align = ["left", "center", "right"].includes(style.align) ? style.align : undefined;
  out.dash = num(style.dash, 0, 100);
  out.cornerRadius = num(style.cornerRadius, 0, 500);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// Validates + normalizes a canvas object payload. Returns
// { type, payload: {x,y,w,h,rot,style,data} } or null.
export function normalizeObjectPayload(obj) {
  const num = (v, def = 0) => (typeof v === "number" && isFinite(v) ? v : def);
  const x = num(obj.x);
  const y = num(obj.y);
  let w = num(obj.w, 100);
  let h = num(obj.h, 100);
  w = Math.min(Math.max(w, 1), 200000);
  h = Math.min(Math.max(h, 1), 200000);
  const rot = num(obj.rot);
  const style = sanitizeStyle(obj.style || {});
  const groupId = typeof obj.groupId === "string" ? obj.groupId.slice(0, 64) : "";
  let data = {};

  switch (obj.type) {
    case "line":
    case "arrow": {
      const x2 = num(obj.data?.x2, x + w);
      const y2 = num(obj.data?.y2, y + h);
      data = { x2, y2 };
      break;
    }
    case "freehand": {
      let pts = Array.isArray(obj.data?.points) ? obj.data.points : [];
      if (pts.length > LIMITS.MAX_POINTS) pts = pts.slice(0, LIMITS.MAX_POINTS);
      data = {
        points: pts
          .slice(0, LIMITS.MAX_POINTS)
          .map((pt) => [num(pt[0]), num(pt[1])]),
      };
      break;
    }
    case "text":
    case "sticky": {
      const text = typeof obj.data?.text === "string" ? obj.data.text.slice(0, LIMITS.MAX_TEXT) : "";
      data = { text };
      break;
    }
    case "image": {
      const src = typeof obj.data?.src === "string" ? obj.data.src : "";
      const isData = src.startsWith("data:image/") && src.length <= LIMITS.MAX_IMAGE_BYTES;
      const isAsset = /^\/api\/workspaces\/[\w-]+\/assets\/[\w-]+$/.test(src);
      if (!isData && !isAsset) return null;
      data = { src };
      break;
    }
    case "comment": {
      const text = typeof obj.data?.text === "string" ? obj.data.text.slice(0, LIMITS.MAX_COMMENT_BODY) : "";
      const resolved = obj.data?.resolved === true;
      const rawThread = Array.isArray(obj.data?.thread) ? obj.data.thread : [];
      const thread = rawThread
        .slice(0, LIMITS.MAX_THREAD_ENTRIES)
        .map((t) => ({
          id: typeof t?.id === "string" ? t.id.slice(0, 64) : "",
          authorId: typeof t?.authorId === "string" ? t.authorId.slice(0, 64) : "",
          authorName: typeof t?.authorName === "string" ? t.authorName.slice(0, 64) : "",
          body: typeof t?.body === "string" ? t.body.slice(0, LIMITS.MAX_COMMENT_BODY) : "",
          at: typeof t?.at === "number" && isFinite(t.at) ? t.at : 0,
        }))
        .filter((t) => t.id && t.body);
      data = { text, resolved, thread };
      break;
    }
    case "frame": {
      const title = typeof obj.data?.title === "string" ? obj.data.title.slice(0, 200) : "Frame";
      data = { title };
      break;
    }
    case "connector": {
      data = {
        fromId: typeof obj.data?.fromId === "string" ? obj.data.fromId.slice(0, 64) : null,
        toId: typeof obj.data?.toId === "string" ? obj.data.toId.slice(0, 64) : null,
        fromPt: Array.isArray(obj.data?.fromPt) ? [num(obj.data.fromPt[0]), num(obj.data.fromPt[1])] : null,
        toPt: Array.isArray(obj.data?.toPt) ? [num(obj.data.toPt[0]), num(obj.data.toPt[1])] : null,
      };
      break;
    }
    case "rectangle":
    case "ellipse":
      data = {};
      break;
    default:
      return null;
  }

  return { x, y, w, h, rot, style, data, groupId };
}

export function newObjectId() {
  return (
    "obj_" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

// Stable id for one comment-thread entry. The client generates it so its
// optimistic echo and the server copy share the same React key.
export function newCommentEntryId() {
  return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Validate a virtual-file-system path (shared by REST API + execution).
// Returns null when valid, otherwise an error message.
// Folders are stored with a trailing slash ("src/"), so exactly one trailing
// slash is legal — validate the segments without it. (Before this fix every
// UI "New folder" request 400'd: "src/".split("/") yields a trailing "".)
export function validateFilePath(path) {
  if (typeof path !== "string" || !path) return "path required";
  if (path.length > LIMITS.MAX_PATH) return "path too long";
  if (path.includes("\\")) return "invalid path";
  const core = path.endsWith("/") ? path.slice(0, -1) : path;
  if (!core) return "invalid path segment";
  const parts = core.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return "invalid path segment";
  if (parts.length > 12) return "too deep";
  if (/[\u0000-\u001f<>:"|?*]/.test(path)) return "invalid characters";
  return null;
}
