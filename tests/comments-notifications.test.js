import { test } from "node:test";
import assert from "node:assert/strict";
import { OP, LIMITS, validateCanvasOp, normalizeObjectPayload, opSummary } from "../src/shared/protocol.js";
import { applyCanvasOp } from "../src/shared/canvasOps.js";
import { extractMentions, shapeNotification } from "../server/lib/notifications.js";

// ---------- comment operations ----------

test("comment ops: reply is sanitized and given an id + timestamp", () => {
  const res = validateCanvasOp({
    type: OP.COMMENT,
    oid: "obj1",
    p: { action: "reply", entry: { body: "  hello  " } },
  });
  assert.equal(res.ok, true);
  assert.equal(res.op.p.action, "reply");
  assert.ok(res.op.p.entry.id.startsWith("c_"));
  assert.equal(res.op.p.entry.body, "  hello  ");
  assert.ok(res.op.p.entry.at > 0);
});

test("comment ops: empty replies and oversized bodies are handled", () => {
  assert.equal(
    validateCanvasOp({ type: OP.COMMENT, oid: "o", p: { action: "reply", entry: { body: "   " } } }).ok,
    false
  );
  const long = "x".repeat(LIMITS.MAX_COMMENT_BODY + 50);
  const res = validateCanvasOp({ type: OP.COMMENT, oid: "o", p: { action: "reply", entry: { body: long } } });
  assert.equal(res.ok, true);
  assert.equal(res.op.p.entry.body.length, LIMITS.MAX_COMMENT_BODY);
});

test("comment ops: resolve and edit validate their payloads", () => {
  const resolve = validateCanvasOp({ type: OP.COMMENT, oid: "o", p: { action: "resolve", resolved: true } });
  assert.equal(resolve.ok, true);
  assert.equal(resolve.op.p.resolved, true);

  const edit = validateCanvasOp({ type: OP.COMMENT, oid: "o", p: { action: "edit", text: "new subject" } });
  assert.equal(edit.ok, true);
  assert.equal(edit.op.p.text, "new subject");

  assert.equal(validateCanvasOp({ type: OP.COMMENT, oid: "o", p: { action: "edit", text: 5 } }).ok, false);
  assert.equal(
    validateCanvasOp({
      type: OP.COMMENT,
      oid: "o",
      p: { action: "edit", text: "y".repeat(LIMITS.MAX_COMMENT_BODY + 1) },
    }).ok,
    false
  );
  assert.equal(validateCanvasOp({ type: OP.COMMENT, oid: null, p: { action: "resolve" } }).ok, false);
});

test("comment ops: unknown action or missing object is rejected", () => {
  assert.equal(validateCanvasOp({ type: OP.COMMENT, oid: "o", p: { action: "nope" } }).ok, false);
  assert.equal(validateCanvasOp({ type: OP.COMMENT, p: { action: "resolve" } }).ok, false);
});

// ---------- group operations ----------

test("group ops: absolute groupId, empty string means ungroup", () => {
  const join = validateCanvasOp({ type: OP.GROUP, oid: "o", p: { groupId: "g_1" } });
  assert.equal(join.ok, true);
  assert.equal(join.op.p.groupId, "g_1");

  const leave = validateCanvasOp({ type: OP.GROUP, oid: "o", p: { groupId: "" } });
  assert.equal(leave.ok, true);
  assert.equal(leave.op.p.groupId, "");

  // non-string ids degrade to "ungroup"; long ids are truncated
  const weird = validateCanvasOp({ type: OP.GROUP, oid: "o", p: { groupId: 7 } });
  assert.equal(weird.ok, true);
  assert.equal(weird.op.p.groupId, "");

  const longId = validateCanvasOp({ type: OP.GROUP, oid: "o", p: { groupId: "z".repeat(65) } });
  assert.equal(longId.ok, true);
  assert.equal(longId.op.p.groupId.length, 64);

  assert.equal(validateCanvasOp({ type: OP.GROUP, p: { groupId: "g" } }).ok, false);
});

test("op summary describes comment and group activity for the history log", () => {
  assert.equal(opSummary({ type: OP.COMMENT, p: { action: "reply" } }), "commented");
  assert.equal(opSummary({ type: OP.COMMENT, p: { action: "resolve" } }), "resolved comment");
  assert.equal(opSummary({ type: OP.COMMENT, p: { action: "edit" } }), "edited comment");
  assert.equal(opSummary({ type: OP.GROUP, p: { groupId: "g" } }), "grouped");
  assert.equal(opSummary({ type: OP.GROUP, p: { groupId: "" } }), "ungrouped");
});

// ---------- client-side apply ----------

test("applyCanvasOp: comment reply appends, resolve flips the flag, edit replaces the subject", () => {
  const objects = new Map();
  applyCanvasOp(objects, {
    type: OP.CREATE,
    oid: "cmt",
    p: {
      object: {
        type: "comment",
        z: 0,
        payload: normalizeObjectPayload({
          type: "comment",
          x: 10,
          y: 20,
          data: {
            text: "subject",
            thread: [{ id: "e1", authorId: "u1", authorName: "ana", body: "first", at: 1 }],
          },
        }),
      },
    },
  });
  const obj = objects.get("cmt");
  assert.equal(obj.type, "comment");
  assert.equal(obj.payload.data.thread.length, 1);

  applyCanvasOp(objects, {
    type: OP.COMMENT,
    oid: "cmt",
    p: { action: "reply", entry: { id: "e2", authorId: "u2", authorName: "bo", body: "second", at: 2 } },
  });
  assert.equal(objects.get("cmt").payload.data.thread.length, 2);

  applyCanvasOp(objects, { type: OP.COMMENT, oid: "cmt", p: { action: "resolve", resolved: true } });
  assert.equal(objects.get("cmt").payload.data.resolved, true);

  applyCanvasOp(objects, { type: OP.COMMENT, oid: "cmt", p: { action: "edit", text: "renamed" } });
  assert.equal(objects.get("cmt").payload.data.text, "renamed");

  // replies are capped so a single thread cannot grow without bound
  for (let i = 0; i < LIMITS.MAX_THREAD_ENTRIES + 10; i++) {
    applyCanvasOp(objects, {
      type: OP.COMMENT,
      oid: "cmt",
      p: { action: "reply", entry: { id: `x${i}`, authorId: "u1", authorName: "a", body: "b", at: i } },
    });
  }
  assert.ok(objects.get("cmt").payload.data.thread.length <= LIMITS.MAX_THREAD_ENTRIES);
});

test("applyCanvasOp: group assigns and clears groupId", () => {
  const objects = new Map();
  for (const id of ["a", "b"]) {
    applyCanvasOp(objects, {
      type: OP.CREATE,
      oid: id,
      p: {
        object: {
          type: "rectangle",
          z: 0,
          payload: normalizeObjectPayload({ type: "rectangle", x: 0, y: 0, w: 10, h: 10 }),
        },
      },
    });
  }
  applyCanvasOp(objects, { type: OP.GROUP, oid: "a", p: { groupId: "g1" } });
  applyCanvasOp(objects, { type: OP.GROUP, oid: "b", p: { groupId: "g1" } });
  assert.equal(objects.get("a").payload.groupId, "g1");
  assert.equal(objects.get("b").payload.groupId, "g1");

  applyCanvasOp(objects, { type: OP.GROUP, oid: "a", p: { groupId: "" } });
  assert.equal(objects.get("a").payload.groupId, undefined);
  assert.equal(objects.get("b").payload.groupId, "g1");
});

// ---------- payload normalization ----------

test("normalizeObjectPayload: comment threads are capped, filtered and defaulted", () => {
  const entries = Array.from({ length: LIMITS.MAX_THREAD_ENTRIES + 25 }, (_, i) => ({
    id: `e${i}`,
    authorId: "u",
    authorName: "n",
    body: "b",
    at: i,
  }));
  // entries without an id or body are dropped
  entries.push({ id: "", body: "no id" }, { id: "ok", body: "" });

  const p = normalizeObjectPayload({
    type: "comment",
    x: 0,
    y: 0,
    data: { text: "t", thread: entries, resolved: "yes" },
  });
  assert.equal(p.data.resolved, false);
  assert.equal(p.data.thread.length, LIMITS.MAX_THREAD_ENTRIES);
  assert.ok(p.data.thread.every((t) => t.id && t.body));
});

test("normalizeObjectPayload: frame gets a bounded title and keeps groupId", () => {
  const p = normalizeObjectPayload({ type: "frame", x: 0, y: 0, w: 400, h: 300, data: {}, groupId: "g9" });
  assert.equal(p.data.title, "Frame");
  assert.equal(p.groupId, "g9");

  const long = normalizeObjectPayload({
    type: "frame",
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    data: { title: "z".repeat(300) },
  });
  assert.equal(long.data.title.length, 200);
});

// ---------- notification helpers ----------

test("extractMentions finds unique lowercase usernames", () => {
  const found = extractMentions("hey @Alice and @bob_2, also @Alice again — not @ab");
  assert.deepEqual(found.sort(), ["alice", "bob_2"]);
  assert.deepEqual(extractMentions(""), []);
  assert.deepEqual(extractMentions(null), []);
});

test("shapeNotification converts BigInt timestamps to numbers", () => {
  const shaped = shapeNotification({
    id: "n1",
    userId: "u1",
    workspaceId: "w1",
    type: "mention",
    title: "t",
    body: "b",
    linkType: "object",
    linkId: "o1",
    actorId: "u2",
    readAt: BigInt(0),
    createdAt: BigInt(1700000000000),
  });
  assert.equal(typeof shaped.createdAt, "number");
  assert.equal(shaped.createdAt, 1700000000000);
  assert.equal(shaped.readAt, 0);
});
