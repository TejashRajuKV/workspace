// ============================================================
// SQLite access for the collaboration service.
// Uses node:sqlite (built into Node 22+) — zero native deps.
//
// Shares the SAME database file with the Next.js/Prisma side:
//   - Next.js (Prisma) owns:  users, sessions, workspaces,
//                             workspace_members, documents CRUD
//   - this service owns:      workspace_state, canvas_objects,
//                             operations, document_operations, snapshots
// WAL mode allows concurrent readers + a single writer across processes.
// ============================================================

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH =
  process.env.DATABASE_PATH || path.resolve(__dirname, "../../db/custom.db");

export const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA synchronous = NORMAL");

// Service-owned per-workspace version counters (not exposed to Prisma).
db.exec(`
  CREATE TABLE IF NOT EXISTS workspace_state (
    workspace_id     TEXT PRIMARY KEY,
    version          INTEGER NOT NULL DEFAULT 0,
    snapshot_version INTEGER NOT NULL DEFAULT 0
  )
`);

export function getVersion(workspaceId) {
  const row = db
    .prepare("SELECT version FROM workspace_state WHERE workspace_id = ?")
    .get(workspaceId);
  return row ? row.version : 0;
}

export function nextVersion(workspaceId) {
  db.prepare(
    `INSERT INTO workspace_state (workspace_id, version) VALUES (?, 1)
     ON CONFLICT(workspace_id) DO UPDATE SET version = version + 1`
  ).run(workspaceId);
  return getVersion(workspaceId);
}

// Run fn inside BEGIN IMMEDIATE … COMMIT (retries on busy).
export function tx(fn, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw err;
      }
    } catch (err) {
      const busy = /SQLITE_BUSY|database is locked/i.test(String(err?.message));
      if (busy && i < attempts - 1) {
        const wait = 20 + Math.random() * 60;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
        continue;
      }
      throw err;
    }
  }
}

// --- Session / membership lookups (rows owned by the Prisma side) ---

export function getSessionUser(token) {
  if (!token || typeof token !== "string" || token.length < 16) return null;
  const session = db
    .prepare("SELECT id, user_id, expires_at FROM sessions WHERE id = ?")
    .get(token);
  if (!session) return null;
  if (session.expires_at < Date.now()) return null;
  const user = db
    .prepare("SELECT id, username, color FROM users WHERE id = ?")
    .get(session.user_id);
  return user || null;
}

export function getRole(workspaceId, userId) {
  const row = db
    .prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
    .get(workspaceId, userId);
  return row ? row.role : null;
}

export function workspaceExists(workspaceId) {
  return !!db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
}
