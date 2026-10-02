// Regression: OP.CREATE must resurrect soft-deleted rows (upsert semantics).
//
// Root cause of restore/undo divergence found in inspection pass 2:
//   INSERT OR IGNORE no-oped when a row with the same id already existed but
//   was soft-deleted (deleted=1). The op log then claimed the object exists
//   while the materialized state said otherwise — undo-of-erase vanished on
//   reload and restore's DELETE+CREATE pairs left objects dead server-side.
//
// Run with the other suites:  node --test tests/*.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { OP, validateCanvasOp } from "../src/shared/protocol.js";

// ---------------------------------------------------------------------------
// Minimal row-level harness that mirrors applyToRow's SQL semantics. We don't
// import canvasSync.js directly because it opens the shared app DB on module
// load; instead we replay the exact statements against a scratch DB and assert
// the upsert behavior the service must exhibit.
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE canvas_objects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    type TEXT,
    payload TEXT,
    z_index INTEGER,
    created_by TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    updated_version INTEGER,
    deleted INTEGER
  )`);
  return db;
}

// The EXACT statement canvasSync.applyToRow must run for OP.CREATE.
const CREATE_SQL = `INSERT INTO canvas_objects
  (id, workspace_id, type, payload, z_index, created_by, created_at, updated_at, updated_version, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type,
    payload = excluded.payload,
    z_index = excluded.z_index,
    deleted = 0,
    updated_at = excluded.updated_at,
    updated_version = excluded.updated_version`;

const DELETE_SQL =
  "UPDATE canvas_objects SET deleted = 1, updated_at = ?, updated_version = ? WHERE id = ? AND workspace_id = ?";

function createObj(db, oid, payload, z, version, createdBy = "u1") {
  db.prepare(CREATE_SQL).run(oid, "ws", "rectangle", JSON.stringify(payload), z, createdBy, 1, 1, version);
}

test("CREATE resurrects a soft-deleted row (undo of erase persists)", () => {
  const db = makeDb();
  createObj(db, "o1", { x: 0, y: 0, w: 10, h: 10 }, 1, 1);

  // eraser deletes it…
  db.prepare(DELETE_SQL).run(2, 2, "o1", "ws");
  let row = db.prepare("SELECT deleted FROM canvas_objects WHERE id = 'o1'").get();
  assert.equal(row.deleted, 1);

  // …undo re-CREATEs the same id → row must come back, original creator kept
  createObj(db, "o1", { x: 0, y: 0, w: 10, h: 10 }, 1, 3);
  row = db.prepare("SELECT deleted, created_by, updated_version FROM canvas_objects WHERE id = 'o1'").get();
  assert.equal(row.deleted, 0, "re-CREATE must clear the soft-delete flag");
  assert.equal(row.created_by, "u1", "original creator preserved on conflict");
  assert.equal(row.updated_version, 3);
});

test("CREATE pair emitted by restore replaces payload and clears deletion", () => {
  const db = makeDb();
  createObj(db, "o2", { x: 5, y: 5, w: 9, h: 9 }, 4, 1);

  // restore diff: DELETE then CREATE with the historical (v1) payload
  db.prepare(DELETE_SQL).run(2, 2, "o2", "ws");
  createObj(db, "o2", { x: 0, y: 0, w: 2, h: 2 }, 1, 3, "restorer");

  const row = db.prepare("SELECT * FROM canvas_objects WHERE id = 'o2'").get();
  assert.equal(row.deleted, 0);
  assert.deepEqual(JSON.parse(row.payload), { x: 0, y: 0, w: 2, h: 2 });
  assert.equal(row.z_index, 1);
  assert.equal(row.created_by, "u1", "restorer must not steal attribution on conflict");
});

test("CREATE of a brand-new id still inserts normally", () => {
  const db = makeDb();
  createObj(db, "o3", { x: 1, y: 2, w: 3, h: 4 }, 0, 7, "u9");
  const row = db.prepare("SELECT * FROM canvas_objects WHERE id = 'o3'").get();
  assert.equal(row.deleted, 0);
  assert.equal(row.created_by, "u9");
  assert.deepEqual(JSON.parse(row.payload), { x: 1, y: 2, w: 3, h: 4 });
});

test("protocol validates the CREATE shape used by restore (createdBy stripped, geometry kept)", () => {
  const op = {
    type: OP.CREATE,
    oid: "obj_x",
    p: { object: { id: "obj_x", type: "text", payload: { x: 3, y: 4, w: 10, h: 10, style: {}, data: { text: "hi" } }, z: 1, createdBy: "someone" } },
  };
  const v = validateCanvasOp(op);
  assert.equal(v.ok, true, `restore-shaped CREATE must validate: ${v.error || ""}`);
  // the op contract is {id, type, z, payload} — sender becomes creator on
  // fresh inserts; on conflict the row's original created_by is preserved.
  assert.equal(v.op.p.object.createdBy, undefined);
  assert.deepEqual(
    { x: v.op.p.object.payload.x, y: v.op.p.object.payload.y },
    { x: 3, y: 4 },
    "restore re-CREATE must keep the historical geometry"
  );
  assert.equal(v.op.p.object.z, 1);
});
