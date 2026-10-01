// Canvas engine tests: coordinate conversion, quadtree, op application,
// op validation. Run: node --test tests/canvas.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { worldToScreen, screenToWorld, zoomCameraAt, MIN_ZOOM, MAX_ZOOM } from "../src/components/workspace/canvas-engine/camera.js";
import { Quadtree } from "../src/components/workspace/canvas-engine/quadtree.js";
import { applyCanvasOp } from "../src/shared/canvasOps.js";
import { OP, validateCanvasOp, normalizeObjectPayload } from "../src/shared/protocol.js";

test("coordinate conversion round-trips at any zoom", () => {
  for (const zoom of [0.02, 0.1, 0.5, 1, 2.7, 8]) {
    const cam = { x: 1234.5, y: -9876.2, zoom };
    const w = { x: 555.6, y: -777.8 };
    const s = worldToScreen(cam, w.x, w.y);
    const back = screenToWorld(cam, s.x, s.y);
    assert.ok(Math.abs(back.x - w.x) < 1e-9);
    assert.ok(Math.abs(back.y - w.y) < 1e-9);
  }
});

test("zoom keeps the world point under the cursor anchored", () => {
  const cam = { x: 0, y: 0, zoom: 1 };
  const sx = 400;
  const sy = 300;
  const before = screenToWorld(cam, sx, sy);
  const cam2 = zoomCameraAt(cam, sx, sy, 1.6);
  const after = screenToWorld(cam2, sx, sy);
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
  assert.ok(cam2.zoom > cam.zoom);
});

test("zoom is clamped", () => {
  const cam = { x: 0, y: 0, zoom: MAX_ZOOM };
  assert.equal(zoomCameraAt(cam, 0, 0, 10).zoom, MAX_ZOOM);
  assert.equal(zoomCameraAt({ x: 0, y: 0, zoom: MIN_ZOOM }, 0, 0, 0.001).zoom, MIN_ZOOM);
});

test("quadtree: insert / query / remove correctness", () => {
  const quad = new Quadtree();
  const ids = [];
  for (let i = 0; i < 500; i++) {
    const id = `o${i}`;
    ids.push(id);
    quad.insert(id, { x: Math.random() * 2000 - 1000, y: Math.random() * 2000 - 1000, w: 20, h: 20 });
  }
  const hits = quad.query(-50, -50, 100, 100);
  for (const id of hits) {
    const b = quad.itemBounds.get(id);
    const inter = b.x < 50 && b.x + b.w > -50 && b.y < 50 && b.y + b.h > -50;
    assert.ok(inter, "returned object must intersect query");
  }
  const before = quad.size;
  for (const id of ids.slice(0, 250)) quad.remove(id);
  assert.equal(quad.size, before - 250);
  // no phantom returns after removal
  for (const id of quad.query(-2000, -2000, 4000, 4000)) {
    assert.ok(quad.itemBounds.has(id));
  }
});

test("quadtree: high density + subdivision stays consistent", () => {
  const quad = new Quadtree();
  for (let i = 0; i < 3000; i++) {
    quad.insert(`p${i}`, { x: Math.random() * 100, y: Math.random() * 100, w: 1, h: 1 });
  }
  assert.equal(quad.size, 3000);
  let total = 0;
  const seen = new Set();
  for (let gx = 0; gx < 10; gx++) {
    for (let gy = 0; gy < 10; gy++) {
      for (const id of quad.query(gx * 10, gy * 10, 10, 10)) {
        if (!seen.has(id)) {
          seen.add(id);
          total++;
        }
      }
    }
  }
  assert.equal(total, 3000, "grid sweep must find every object exactly once");
});

function rect(x, y, w = 100, h = 80) {
  return { x, y, w, h, rot: 0, style: { fill: "#fff", stroke: "#000", strokeWidth: 2 }, data: {} };
}

test("canvas ops: create → move → resize → style → delete on a Map", () => {
  const objects = new Map();
  const id = "obj_1";
  assert.ok(
    applyCanvasOp(objects, { type: OP.CREATE, oid: id, p: { object: { id, type: "rectangle", payload: rect(0, 0), z: 1 } } }, "u1")
  );
  assert.ok(objects.has(id));
  applyCanvasOp(objects, { type: OP.MOVE, oid: id, p: { dx: 10, dy: -5 } }, "u1");
  assert.deepEqual([objects.get(id).payload.x, objects.get(id).payload.y], [10, -5]);
  applyCanvasOp(objects, { type: OP.RESIZE, oid: id, p: { x: 0, y: 0, w: 50, h: 40 } }, "u1");
  assert.deepEqual([objects.get(id).payload.w, objects.get(id).payload.h], [50, 40]);
  applyCanvasOp(objects, { type: OP.STYLE, oid: id, p: { style: { fill: "#f00" } } }, "u1");
  assert.equal(objects.get(id).payload.style.fill, "#f00");
  assert.ok(applyCanvasOp(objects, { type: OP.DELETE, oid: id, p: {} }, "u1"));
  assert.ok(!objects.has(id));
  assert.ok(!applyCanvasOp(objects, { type: OP.DELETE, oid: id, p: {} }, "u1"), "deleting twice is a no-op");
});

test("move deltas are commutative (concurrent drags merge additively)", () => {
  const a = new Map();
  const b = new Map();
  for (const m of [a, b])
    applyCanvasOp(m, { type: OP.CREATE, oid: "x", p: { object: { id: "x", type: "rectangle", payload: rect(0, 0), z: 1 } } }, "u");
  // server order: A(+30), B(+70) — both clients apply both in order
  const seq = [
    { type: OP.MOVE, oid: "x", p: { dx: 30, dy: 0 } },
    { type: OP.MOVE, oid: "x", p: { dx: 70, dy: 0 } },
  ];
  for (const op of seq) applyCanvasOp(a, op, "u2");
  applyCanvasOp(b, seq[0], "u2");
  applyCanvasOp(b, seq[1], "u2");
  assert.equal(a.get("x").payload.x, 100);
  assert.equal(b.get("x").payload.x, 100);
});

test("validateCanvasOp rejects malformed / oversized input", () => {
  assert.equal(validateCanvasOp(null).ok, false);
  assert.equal(validateCanvasOp({ type: "nope", oid: "a", p: {} }).ok, false);
  assert.equal(
    validateCanvasOp({ type: OP.MOVE, oid: "a", p: { dx: NaN, dy: 0 } }).ok,
    false
  );
  assert.equal(
    validateCanvasOp({ type: OP.MOVE, oid: "a", p: { dx: 1e9, dy: 0 } }).ok,
    false
  );
  assert.equal(
    validateCanvasOp({ type: OP.CREATE, oid: "a", p: { object: { id: "a", type: "hacker", payload: rect(0, 0) } } }).ok,
    false
  );
  // real wire shape: geometry lives in the nested payload
  const ok = validateCanvasOp({
    type: OP.CREATE,
    oid: "a",
    p: {
      object: {
        id: "a",
        type: "rectangle",
        z: 3,
        payload: { x: 94, y: 5, w: 150, h: 100, rot: 0, style: { fill: "#dbe4f0", stroke: "#334155", strokeWidth: 2 }, data: {} },
      },
    },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(
    [ok.op.p.object.payload.x, ok.op.p.object.payload.y, ok.op.p.object.payload.w, ok.op.p.object.payload.h],
    [94, 5, 150, 100],
    "CREATE geometry must survive validation (regression: payload reset to 0,0,100,100)"
  );
  assert.deepEqual(
    [ok.op.p.object.payload.style.fill, ok.op.p.object.payload.style.strokeWidth],
    ["#dbe4f0", 2],
    "CREATE style must survive validation"
  );
  assert.equal(ok.op.p.object.type, "rectangle");
  assert.equal(ok.op.p.object.z, 3);
});

test("normalizeObjectPayload clamps and sanitizes", () => {
  const n = normalizeObjectPayload({
    type: "sticky",
    x: "abc",
    y: 5,
    w: -10,
    h: 1e9,
    style: { fontSize: 1e6, evil: "x".repeat(9999) },
    data: { text: "hi".repeat(20000) },
  });
  assert.ok(n);
  assert.equal(n.x, 0);
  assert.equal(n.w, 1);
  assert.ok(n.h <= 200000);
  assert.ok(n.style.fontSize <= 400);
  assert.ok(!("evil" in n.style));
  assert.ok(n.data.text.length <= 20000);
  assert.equal(normalizeObjectPayload({ type: "image", data: { src: "http://evil" } }), null);
});
