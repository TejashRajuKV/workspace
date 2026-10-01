// ============================================================
// Collaborative text synchronization (server side).
//
// Classic single-sequencer OT:
//   - each document has a revision counter (= number of applied ops)
//   - a client submits { op, rev } where rev = the revision its op is based on
//   - the server transforms the op against every op that happened since rev
//     (the transformed op is what gets stored & broadcast)
//   - clients apply broadcast ops in revision order; a client that falls too
//     far behind receives a full content reset instead of an op flood
// ============================================================

import { db, tx } from "./db.js";
import TextOperation, { transformPosition } from "../../src/shared/ot.js";
import { DOC_SYNC_MAX_OPS, LIMITS } from "../../src/shared/protocol.js";

// docId → { content, rev, recent: Map(rev → TextOperation) }
const docs = new Map();

function loadDoc(documentId) {
  if (docs.has(documentId)) return docs.get(documentId);
  const row = db
    .prepare("SELECT content, doc_version, deleted, is_folder FROM documents WHERE id = ?")
    .get(documentId);
  if (!row || row.deleted || row.is_folder) return null;
  const state = {
    content: row.content,
    rev: row.doc_version,
    recent: new Map(),
    loadedRecent: false,
  };
  docs.set(documentId, state);
  // pre-load the most recent ops so late submissions can be transformed
  const rows = db
    .prepare(
      "SELECT version, op FROM document_operations WHERE document_id = ? ORDER BY version DESC LIMIT ?"
    )
    .all(documentId, DOC_SYNC_MAX_OPS);
  for (const r of rows) {
    try {
      state.recent.set(r.version, TextOperation.fromJSON(JSON.parse(r.op)));
    } catch {}
  }
  state.loadedRecent = true;
  return state;
}

export function getDocState(documentId) {
  const s = loadDoc(documentId);
  return s ? { content: s.content, rev: s.rev } : null;
}

export function openDoc(socket, documentId, cb) {
  const s = loadDoc(documentId);
  if (!s) return cb({ error: "Document not found" });
  cb({ content: s.content, rev: s.rev });
}

// Submit an operation. cb called with { rev } or { error }.
export function submitDocOp(io, socket, room, documentId, opComponents, baseRev) {
  const s = loadDoc(documentId);
  if (!s) return { error: "Document not found" };

  if (!Array.isArray(opComponents)) return { error: "Bad op" };
  let op;
  try {
    op = TextOperation.fromJSON(opComponents);
  } catch (err) {
    return { error: "Bad op: " + err.message };
  }
  if (op.isNoop()) return { rev: s.rev };
  // reject unreasonably large inserts
  const inserted = op.ops
    .filter((c) => typeof c === "string")
    .reduce((n, c) => n + c.length, 0);
  if (inserted > LIMITS.MAX_FILE_BYTES) return { error: "Insertion too large" };

  if (typeof baseRev !== "number" || baseRev < 0 || baseRev > s.rev)
    return { error: "Unknown revision" };
  if (s.rev - baseRev > DOC_SYNC_MAX_OPS)
    return { error: "Revision too stale — resync required", stale: true };

  try {
    // transform against everything that happened since baseRev
    for (let rev = baseRev + 1; rev <= s.rev; rev++) {
      const other = s.recent.get(rev);
      if (!other) return { error: "History unavailable — resync required", stale: true };
      const pair = TextOperation.transform(op, other);
      op = pair[0];
    }

    const newRev = tx(() => {
      // re-read content inside the tx to stay consistent
      const row = db
        .prepare("SELECT content, doc_version FROM documents WHERE id = ?")
        .get(documentId);
      if (!row) throw new Error("Document vanished");
      const content = op.apply(row.content);
      db.prepare("UPDATE documents SET content = ?, doc_version = ?, updated_at = ? WHERE id = ?").run(
        content,
        row.doc_version + 1,
        Date.now(),
        documentId
      );
      db.prepare(
        "INSERT INTO document_operations (workspace_id, document_id, user_id, op, base_rev, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        room,
        documentId,
        socket.data.userId,
        JSON.stringify(op.toJSON()),
        baseRev,
        row.doc_version + 1,
        Date.now()
      );
      return row.doc_version + 1;
    });

    s.content = op.apply(s.content);
    s.rev = newRev;
    s.recent.set(newRev, op);
    // prune
    if (s.recent.size > DOC_SYNC_MAX_OPS + 50) {
      const minKeep = newRev - DOC_SYNC_MAX_OPS;
      for (const k of s.recent.keys()) if (k < minKeep) s.recent.delete(k);
    }

    // broadcast (except sender, who gets the ack with the same info)
    socket.to(`ws:${room}`).emit("doc:op", {
      documentId,
      op: op.toJSON(),
      rev: newRev,
      by: socket.data.userId,
    });
    return { rev: newRev, op: op.toJSON() };
  } catch (err) {
    console.error("[doc] submit failed:", err.message);
    return { error: "Apply failed: " + err.message };
  }
}

// Catch a lagging client up: ops since `since`, or full reset.
export function syncDoc(documentId, since) {
  const s = loadDoc(documentId);
  if (!s) return { error: "Document not found" };
  if (typeof since !== "number" || since < 0 || since > s.rev)
    return { reset: true, content: s.content, rev: s.rev };
  if (s.rev - since > DOC_SYNC_MAX_OPS)
    return { reset: true, content: s.content, rev: s.rev };

  const rows = db
    .prepare(
      "SELECT version, op, user_id FROM document_operations WHERE document_id = ? AND version > ? ORDER BY version ASC"
    )
    .all(documentId, since);
  if (rows.length !== s.rev - since) {
    // history pruned/incomplete → full reset is the safe answer
    return { reset: true, content: s.content, rev: s.rev };
  }
  return {
    ops: rows.map((r) => ({ rev: r.version, op: JSON.parse(r.op), by: r.user_id })),
    rev: s.rev,
  };
}

// File deleted/renamed through the REST API → drop cached state
export function invalidateDoc(documentId) {
  docs.delete(documentId);
}

export { transformPosition };
