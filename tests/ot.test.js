// OT correctness tests — the heart of collaborative text editing.
// Run: node --test tests/ot.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import TextOperation, { transformPosition } from "../src/shared/ot.js";

const randomInt = (n) => Math.floor(Math.random() * n);
const randomString = (n, chars = "abcdefghij\n ") => {
  let s = "";
  for (let i = 0; i < n; i++) s += chars[randomInt(chars.length)];
  return s;
};

function randomOp(doc) {
  const op = new TextOperation();
  let pos = 0;
  while (pos < doc.length) {
    const remaining = doc.length - pos;
    const kind = randomInt(3);
    if (kind === 0 && doc.length < 200) {
      op.insert(randomString(1 + randomInt(10)));
    } else if (kind === 1) {
      const n = 1 + randomInt(Math.min(remaining, 10));
      op.delete(n);
      pos += n;
    } else {
      const n = 1 + randomInt(Math.min(remaining, 15));
      op.retain(n);
      pos += n;
    }
  }
  return op;
}

test("apply respects base/target lengths", () => {
  const op = new TextOperation().retain(2).insert("XY").delete(3).retain(1);
  assert.equal(op.baseLength, 6);
  assert.equal(op.targetLength, 5);
  assert.equal(op.apply("abCDEf"), "abXYf");
});

test("invert produces the identity when applied after", () => {
  for (let i = 0; i < 50; i++) {
    const doc = randomString(randomInt(60));
    const op = randomOp(doc);
    const inverse = op.invert(doc);
    assert.equal(inverse.apply(op.apply(doc)), doc, `doc=${JSON.stringify(doc)}`);
  }
});

test("compose algebraic identity: apply(apply(s,a),b) == apply(s, compose(a,b))", () => {
  for (let i = 0; i < 100; i++) {
    let doc = randomString(randomInt(60));
    const a = randomOp(doc);
    const mid = a.apply(doc);
    const b = randomOp(mid);
    const composed = a.compose(b);
    assert.equal(
      composed.apply(doc),
      b.apply(mid),
      `doc=${JSON.stringify(doc)} a=${JSON.stringify(a.toJSON())} b=${JSON.stringify(b.toJSON())}`
    );
  }
});

test("TP1 property: transform convergence from both sides (100 random pairs)", () => {
  for (let i = 0; i < 100; i++) {
    const doc = randomString(randomInt(80) + 10);
    const a = randomOp(doc);
    const b = randomOp(doc);
    const [a1, b1] = TextOperation.transform(a, b);
    const left = b1.apply(a.apply(doc)); // a then b'
    const right = a1.apply(b.apply(doc)); // b then a'
    assert.equal(left, right, `doc=${JSON.stringify(doc)}`);
  }
});

test("transform is symmetric under argument swap (tie-break determinism)", () => {
  for (let i = 0; i < 100; i++) {
    const doc = randomString(randomInt(60) + 10);
    const a = randomOp(doc);
    const b = randomOp(doc);
    const [a1, b1] = TextOperation.transform(a, b);
    const [b2, a2] = TextOperation.transform(b, a);
    // both argument orders must converge to the same document — this is what
    // makes the tie-break deterministic regardless of delivery order
    assert.equal(b1.apply(a.apply(doc)), a2.apply(b.apply(doc)));
    assert.equal(a1.apply(b.apply(doc)), b2.apply(a.apply(doc)));
  }
});

test("transformPosition keeps carets consistent", () => {
  const op = new TextOperation().retain(5).insert("hello").retain(2).delete(3);
  // doc: "abcde|fghij" → target: "abcdehello|fg"
  assert.equal(transformPosition(0, op), 0);
  // caret exactly at the insert point: stays before others' inserts…
  assert.equal(transformPosition(5, op), 5);
  // …but shifts after its own insert
  assert.equal(transformPosition(5, op, true), 10);
  assert.equal(transformPosition(6, op), 11);
  // caret inside the deleted span [7,10) clamps to the span start (target 12)
  assert.equal(transformPosition(7, op), 12);
  assert.equal(transformPosition(8, op), 12);
  assert.equal(transformPosition(9, op), 12);
  // after the deletion: f g → caret past end lands at target end
  assert.equal(transformPosition(10, op), 12);
});
