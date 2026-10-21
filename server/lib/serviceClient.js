// Internal client for talking to the collaboration mini-service
// (server-to-server, direct to localhost — never exposed to the browser).
//
// The service performs: canvas/document operation processing, snapshots,
// version restore and filesystem-change broadcasts.

const COLLAB_URL = process.env.COLLAB_SERVICE_URL || "http://127.0.0.1:3004";
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "iw-internal-token";

async function post(path, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${COLLAB_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": INTERNAL_TOKEN,
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: String(err?.message || err) } };
  } finally {
    clearTimeout(t);
  }
}

export const serviceClient = {
  notifyFsChanged: (workspaceId, kind) =>
    post("/internal/fs-changed", { workspaceId, kind }, 3000),
  replaceDoc: (workspaceId, documentId, content, byUserId) =>
    post("/internal/replace-doc", { workspaceId, documentId, content, byUserId }, 10000),
  restore: (workspaceId, version, byUserId, byName) =>
    post("/internal/restore", { workspaceId, version, byUserId, byName }, 20000),
  // Push a notification to a specific user's room.
  notifyUser: (userId, notification) =>
    post("/internal/notify", { userId, notification }, 3000),
  // Broadcast an arbitrary workspace-scoped event (client listeners).
  broadcast: (workspaceId, event, payload) =>
    post("/internal/broadcast", { workspaceId, event, payload }, 3000),
  // Seed canvas objects by replaying CREATE ops through the sequencer.
  seedCanvas: (workspaceId, byUserId, objects) =>
    post("/internal/seed-canvas", { workspaceId, byUserId, objects }, 20000),
  health: () => post("/internal/health", {}, 2000),
};