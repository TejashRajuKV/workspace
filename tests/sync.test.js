// Synchronization convergence tests.
// Run: node --test tests/sync.test.js
//
// Proves the two guarantees the sync design rests on:
//   1. total-order broadcast: identical op sequences → identical state
//   2. offline rebase: apply missed remote records + re-apply own pending
//      ops → exactly the server's canonical state
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCanvasOp } from "../src/shared/canvasOps.js";
import { OP } from "../src/shared/protocol.js";
import TextOperation from "../src/shared/ot.js";

function seedObjects() {
  const m = new Map();
  for (let i = 0; i < 6; i++) {
    const id = `obj${i}`;
    applyCanvasOp(
      m,
      {
        type: OP.CREATE,
        oid: id,
        p: {
          object: {
            id,
            type: "rectangle",
            payload: { x: i * 50, y: 0, w: 40, h: 30, rot: 0, style: { fill: "#fff" }, data: {} },
            z: i,
          },
        },
      },
      "seed"
    );
  }
  return m;
}

function randomClientOp(rand) {
  const oid = `obj${rand(6)}`;
  const kinds = ["move", "move", "move", "style", "resize", "rotate", "delete", "text"];
  const kind = kinds[rand(kinds.length)];
  switch (kind) {
    case "move":
      return { type: OP.MOVE, oid, p: { dx: rand(21) - 10, dy: rand(21) - 10 } };
    case "style":
      return { type: OP.STYLE, oid, p: { style: { fill: `#${rand(4096).toString(16).padStart(3, "0")}` } } };
    case "resize":
      return { type: OP.RESIZE, oid, p: { x: rand(50), y: rand(50), w: 20 + rand(80), h: 20 + rand(80) } };
    case "rotate":
      return { type: OP.ROTATE, oid, p: { rot: rand(628) / 100 } };
    case "text":
      return { type: OP.TEXT, oid, p: { text: `t${rand(100)}` } };
    case "delete":
      return { type: OP.DELETE, oid, p: {} };
  }
}

test("all clients converge when ops are applied in server (version) order", () => {
  for (let trial = 0; trial < 40; trial++) {
    const rand = (n) => Math.floor(Math.random() * n);
    const server = seedObjects();
    const log = [];
    for (let v = 0; v < 120; v++) {
      const op = randomClientOp(rand);
      const ok = applyCanvasOp(server, op, "u", 0);
      if (ok) log.push(op);
    }
    // three clients replay the log from the same seed (idempotent CREATEs skipped)
    for (let c = 0; c < 3; c++) {
      const client = seedObjects();
      for (const op of log) applyCanvasOp(client, op, "u", 0);
      assert.deepEqual(
        [...client.keys()].sort(),
        [...server.keys()].sort(),
        "object sets must match"
      );
      for (const [id, obj] of server) {
        assert.deepEqual(
          JSON.stringify(client.get(id)?.payload),
          JSON.stringify(obj.payload),
          `client ${c} object ${id} diverged`
        );
      }
    }
  }
});

test("offline rebase: reconnecting client matches server canonical state", () => {
  for (let trial = 0; trial < 60; trial++) {
    const rand = (n) => Math.floor(Math.random() * n);
    const server = seedObjects();

    // client is at version 0 and goes offline
    const client = seedObjects();

    // remote ops happen server-side while the client is away
    const missed = [];
    for (let v = 0; v < 30; v++) {
      const op = randomClientOp(rand);
      if (applyCanvasOp(server, op, "remote", 0)) missed.push(op);
    }

    // client generates pending ops locally (optimistic apply while offline)
    const pending = [];
    for (let v = 0; v < 12; v++) {
      const op = randomClientOp(rand);
      if (applyCanvasOp(client, op, "me", 0)) pending.push(op);
    }

    // ---- reconnect ----
    // sync:request returns the server's canonical record for every object
    // touched by the missed range (state BEFORE the pending ops are resubmitted)
    const touchedRemote = new Set(missed.map((o) => o.oid));
    const serverRecords = new Map();
    for (const id of touchedRemote) {
      const rec = server.get(id);
      serverRecords.set(
        id,
        rec
          ? { payload: JSON.parse(JSON.stringify(rec.payload)), z: rec.z }
          : { deleted: true }
      );
    }
    // 1. replace touched objects with server-canonical records
    for (const [id, rec] of serverRecords) {
      if (rec.deleted) client.delete(id);
      else client.set(id, { id, payload: JSON.parse(JSON.stringify(rec.payload)), z: rec.z });
    }
    // 2. re-apply pending ops ONLY on replaced objects (non-replaced objects
    //    still carry their optimistic pending effects)
    for (const op of pending) {
      if (!touchedRemote.has(op.oid)) continue;
      applyCanvasOp(client, op, "me", 0);
    }
    // 3. resubmit → server applies them after the remote ops (same rejects:
    //    ops on vanished objects no-op on BOTH sides)
    for (const op of pending) applyCanvasOp(server, op, "me", 0);

    // assert convergence with the server
    assert.deepEqual([...client.keys()].sort(), [...server.keys()].sort());
    for (const [id, obj] of server) {
      assert.deepEqual(
        JSON.stringify(client.get(id)?.payload),
        JSON.stringify(obj.payload),
        `rebase diverged on ${id}`
      );
    }
  }
});

test("text OT: server-sequenced pipeline converges for two clients", () => {
  for (let trial = 0; trial < 50; trial++) {
    const rand = (n) => Math.floor(Math.random() * n);
    let serverDoc = randomDoc(rand);
    let serverRev = 0;
    const serverLog = [];

    const mkClient = () => ({
      doc: serverDoc,
      rev: serverRev,
      outstanding: null, // op in flight (not yet acked)
      buffer: [],
    });

    // server processes the client's in-flight op (ack drains buffer → flight)
    // Wire ordering: broadcasts emitted before the ack are delivered first,
    // so the client is fully caught up to `serverRev` before its ack lands.
    const serverStep = (c) => {
      if (!c.outstanding) return;
      while (c.rev < serverRev) remote(c);
      const incoming = c.outstanding;
      serverDoc = incoming.apply(serverDoc);
      serverLog.push(incoming);
      serverRev++;
      c.rev = serverRev;
      c.outstanding = c.buffer.shift() || null;
    };

    // client submits a local edit
    const submit = (c, op) => {
      c.doc = op.apply(c.doc);
      if (c.outstanding) c.buffer.push(op);
      else c.outstanding = op;
    };

    // server pushes its next logged op to the client (transformed on arrival)
    const remote = (c) => {
      if (c.rev === serverRev) return;
      let r = serverLog[c.rev];
      if (c.outstanding) {
        const pair = TextOperation.transform(c.outstanding, r);
        c.outstanding = pair[0];
        r = pair[1];
        const nb = [];
        for (const bo of c.buffer) {
          const p = TextOperation.transform(bo, r);
          nb.push(p[0]);
          r = p[1];
        }
        c.buffer = nb;
      }
      c.doc = r.apply(c.doc);
      c.rev++;
    };

    const a = mkClient();
    const b = mkClient();
    // Per iteration: clients may submit, in-flight broadcasts are delivered
    // (socket.io preserves order: broadcasts precede the ack), then the
    // server processes each client's in-flight op and acks it.
    for (let step = 0; step < 30; step++) {
      if (Math.random() < 0.6) submit(a, randomTextOp(rand, a.doc));
      if (Math.random() < 0.6) submit(b, randomTextOp(rand, b.doc));
      remote(a);
      remote(b);
      serverStep(a);
      serverStep(b);
    }
    // drain: everyone catches up to the server
    for (let i = 0; i < 300; i++) {
      remote(a);
      remote(b);
      serverStep(a);
      serverStep(b);
    }
    assert.equal(a.rev, serverRev, "client A caught up");
    assert.equal(b.rev, serverRev, "client B caught up");
    assert.equal(a.doc, serverDoc, "client A converged");
    assert.equal(b.doc, serverDoc, "client B converged");
  }
});

function randomDoc(rand) {
  const words = ["function", "login", "const", "x", "=", "42;", "return", "true", "// todo\n"];
  let s = "";
  for (let i = 0; i < 8 + rand(12); i++) s += words[rand(words.length)] + (rand(2) ? " " : "\n");
  return s;
}

function randomTextOp(rand, doc) {
  const op = new TextOperation();
  const pos = rand(doc.length + 1);
  op.retain(pos);
  if (rand(2)) {
    op.insert(`L${rand(99)}`);
    op.retain(doc.length - pos);
  } else {
    const n = Math.min(doc.length - pos, 1 + rand(4));
    op.delete(n);
    op.retain(doc.length - pos - n);
  }
  return op;
}
