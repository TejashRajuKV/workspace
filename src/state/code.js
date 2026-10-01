"use client";

import { create } from "zustand";
import TextOperation, { transformPosition } from "@/shared/ot";
import { LIMITS, DOC_SYNC_MAX_OPS } from "@/shared/protocol";
import { on, getSocket } from "@/lib/socket";
import { useBoard } from "@/state/board";

// ---------------------------------------------------------------------------
// Per-document client OT state (ShareJS-style single-outstanding pipeline):
//
//   local edit ──► apply locally ──► outstanding? ──► buffer
//                                       │ send
//   ack(rev) ◄──────────────────────────┘ → outstanding = compose(buffer)
//   remote op ──► transform(outstanding, remote) etc. ──► apply remote'
//
// Undo/redo: per-user inverse ops transformed forward through every op that
// landed after them (see docs/synchronization.md §Undo).
// ---------------------------------------------------------------------------

const docStates = new Map(); // docId → state
const MAX_LOG = 500;

function newState(content, rev) {
  return {
    content,
    rev,
    outstanding: null, // TextOperation in flight
    buffer: [], // TextOperations queued behind outstanding
    appliedLog: [], // [{ op: TextOperation, by }] — linear op history
    undoStack: [], // { op, before, logIndex }
    redoStack: [],
  };
}

function getState(docId, content = "", rev = 0) {
  if (!docStates.has(docId)) docStates.set(docId, newState(content, rev));
  return docStates.get(docId);
}

function logOp(state, op, by) {
  state.appliedLog.push({ op, by });
  if (state.appliedLog.length > MAX_LOG) state.appliedLog.splice(0, state.appliedLog.length - MAX_LOG);
}

// ---------------------------------------------------------------------------
// Reconnect / stall recovery.
//
// If an op is outstanding when the socket drops, its ack is lost forever:
// without recovery every later keystroke queues into `buffer` and the editor
// silently stops syncing.
//
// Recovery: fetch the ops the server applied since our rev (doc:sync), feed
// them through the normal applyRemote path (which transforms outstanding +
// buffer correctly), then resolve the outstanding op:
//   - it landed server-side (our userId shows up in the missed range)
//       → promote the buffer (never re-send — OT tie-break would duplicate it)
//   - it never landed → re-send it at the current rev (server transforms it)
// If the history window was pruned (full reset), fall back to a clean reset.
// ---------------------------------------------------------------------------

const OUTSTANDING_TIMEOUT_MS = 12000;
const recoverTimers = new Map(); // docId → timeout

function clearRecoverTimer(docId) {
  const t = recoverTimers.get(docId);
  if (t) {
    clearTimeout(t);
    recoverTimers.delete(docId);
  }
}

function armRecoverTimer(docId) {
  clearRecoverTimer(docId);
  recoverTimers.set(
    docId,
    setTimeout(() => {
      recoverTimers.delete(docId);
      const st = docStates.get(docId);
      // only recover when an op is actually stuck in flight
      if (st && st.outstanding) recoverDoc(docId);
    }, OUTSTANDING_TIMEOUT_MS)
  );
}

// Bring a doc with pending (unacked) work back into a consistent pipeline.
export function recoverDoc(docId) {
  const state = docStates.get(docId);
  if (!state) return;
  if (!state.outstanding && !state.buffer.length) return;
  clearRecoverTimer(docId);
  const baseRev = state.rev;
  getSocket().emit("doc:sync", { documentId: docId, since: baseRev }, (res) => {
    if (res?.error) return;
    const st = docStates.get(docId);
    if (!st) return;
    if (res.reset) {
      // history window pruned — a clean reset is the only safe answer
      st.content = res.content;
      st.rev = res.rev;
      st.outstanding = null;
      st.buffer = [];
      st.appliedLog = [];
      st.undoStack = [];
      st.redoStack = [];
      useCode.getState().bumpTick();
      try {
        window.dispatchEvent(new CustomEvent("iw-doc-reset", { detail: { docId } }));
      } catch {}
      return;
    }
    const myId = useBoard.getState().me?.id;
    let mineLanded = false;
    for (const entry of res.ops || []) {
      if (entry.by === myId) {
        // own echo: the server applied OUR op (e.g. socket.io flushed the
        // buffered emit on reconnect). Our optimistic content already
        // includes its effect — applying the echo again would duplicate it
        // (insert×insert tie-break keeps both copies). Collapse the
        // outstanding op into a pure retain so later transforms chain from
        // the post-echo base; buffered ops were typed on top of our op, so
        // their base already matches the server's.
        mineLanded = true;
        if (st.outstanding) {
          const noop = new TextOperation();
          noop.retain(st.outstanding.targetLength);
          st.outstanding = noop;
        }
        st.rev = entry.rev; // keep the sequential-rev chain intact
        continue;
      }
      useCode.getState().applyRemote(docId, entry.op, entry.rev, entry.by);
      if (docStates.get(docId) !== st) return; // doc was reset underneath us
    }
    st.rev = res.rev; // adopt the true server rev (own echoes were skipped)
    const flushNext = () => {
      if (st.buffer.length) {
        let composed = st.buffer[0];
        for (let i = 1; i < st.buffer.length; i++) composed = composed.compose(st.buffer[i]);
        st.buffer = [];
        sendOutstanding(docId, st, composed);
      } else {
        st.outstanding = null;
      }
      useCode.getState().bumpTick();
    };
    if (st.outstanding) {
      if (mineLanded) {
        // our original op is part of the server history — never re-send it
        flushNext();
      } else {
        // the op never landed — re-air it at the current rev
        sendOutstanding(docId, st, st.outstanding);
      }
    } else if (st.buffer.length) {
      flushNext();
    }
    try {
      window.dispatchEvent(new CustomEvent("iw-doc-recovered", { detail: { docId } }));
    } catch {}
  });
}

export function recoverAllDocs() {
  for (const [docId, st] of docStates) {
    if (st.outstanding || st.buffer.length) recoverDoc(docId);
  }
}

export const useCode = create((set, get) => ({
  docs: [], // [{ id, path, isFolder, content, docVersion }]
  openTabs: [], // [docId]
  activeDocId: null,
  fsTick: 0, // bumped when the tree changes (FileExplorer re-reads docs)

  setDocs(docs) {
    // preserve OT state for known docs; drop states for vanished docs
    const known = new Set(docs.map((d) => d.id));
    for (const id of [...docStates.keys()]) {
      if (!known.has(id)) {
        docStates.delete(id);
      }
    }
    let { openTabs, activeDocId } = get();
    openTabs = openTabs.filter((id) => known.has(id));
    if (activeDocId && !known.has(activeDocId)) activeDocId = openTabs[0] || null;
    set({ docs, openTabs, activeDocId, fsTick: get().fsTick + 1 });
  },

  openDoc(docId) {
    let { openTabs, activeDocId } = get();
    if (!openTabs.includes(docId)) openTabs = [...openTabs, docId].slice(-12);
    set({ openTabs, activeDocId: docId });
    const doc = get().docs.find((d) => d.id === docId);
    if (doc && !docStates.has(docId)) {
      getState(docId, doc.content, doc.docVersion);
    }
    // fetch authoritative state (in case another client edited before us).
    // Adopt content AND rev whenever there is no pending local work — the
    // pipeline is worthless if rev drifts from the server (every op would be
    // rejected as a base-length mismatch).
    getSocket().emit("doc:open", { documentId: docId }, (res) => {
      if (res?.error) return;
      const state = getState(docId);
      if (!state.outstanding && !state.buffer.length) {
        state.content = res.content;
        state.rev = res.rev;
        get().bumpTick();
      }
    });
  },

  closeDoc(docId) {
    let { openTabs, activeDocId } = get();
    openTabs = openTabs.filter((id) => id !== docId);
    if (activeDocId === docId) activeDocId = openTabs[openTabs.length - 1] || null;
    set({ openTabs, activeDocId });
  },

  bumpTick: () => set({ fsTick: get().fsTick + 1 }),

  // ---- OT pipeline ----
  // Called by the editor binding for LOCAL edits (already applied in Monaco).
  submitLocal(docId, op) {
    if (useBoard.getState().role === "viewer") return null;
    const state = getState(docId);
    try {
      state.content = op.apply(state.content);
    } catch {
      return null;
    }
    logOp(state, op, "local");
    state.undoStack.push({
      op,
      logIndex: state.appliedLog.length,
    });
    if (state.undoStack.length > 150) state.undoStack.splice(0, state.undoStack.length - 150);
    state.redoStack = [];

    if (state.outstanding) {
      state.buffer.push(op);
    } else {
      sendOutstanding(docId, state, op);
    }
    get().bumpTick();
    return op;
  },

  // Remote op (server-transformed, sequential revs)
  applyRemote(docId, opComponents, rev, by) {
    const state = getState(docId);
    if (rev !== state.rev + 1) {
      // gap → recover (fetch canonical content, replay unsent local work)
      recoverDoc(docId);
      return;
    }
    let remote;
    try {
      remote = TextOperation.fromJSON(opComponents);
    } catch {
      return;
    }
    try {
      if (state.outstanding) {
        const pair = TextOperation.transform(state.outstanding, remote);
        state.outstanding = pair[0];
        remote = pair[1];
        const newBuffer = [];
        for (const op of state.buffer) {
          const p = TextOperation.transform(op, remote);
          newBuffer.push(p[0]);
          remote = p[1];
        }
        state.buffer = newBuffer;
      }
      state.content = remote.apply(state.content);
      state.rev = rev;
      logOp(state, remote, by);
      // transform remote cursors through the incoming op
      for (const [uid, cur] of state.remoteCursors || []) {
        if (uid === by) continue;
        cur.offset = transformPosition(cur.offset, remote, false);
        cur.anchor = transformPosition(cur.anchor, remote, false);
      }
      get().bumpTick();
      return remote; // caller applies this exact op to the Monaco model
    } catch (err) {
      recoverDoc(docId);
      return null;
    }
  },

  ack(docId, rev) {
    const state = docStates.get(docId);
    if (!state) return;
    state.rev = Math.max(state.rev, rev);
    if (state.outstanding) {
      if (state.buffer.length) {
        // compose queued ops into the next outstanding op
        let composed = state.buffer[0];
        for (let i = 1; i < state.buffer.length; i++) {
          composed = composed.compose(state.buffer[i]);
        }
        state.buffer = [];
        sendOutstanding(docId, state, composed);
      } else {
        state.outstanding = null;
      }
    }
    get().bumpTick();
  },

  // ---- text undo/redo (transformed inverse ops) ----
  undoDoc(docId) {
    const state = docStates.get(docId);
    if (!state || state.outstanding || state.buffer.length) return null;
    const entry = state.undoStack[state.undoStack.length - 1];
    if (!entry) return null;
    let op = entry.op;
    for (let i = entry.logIndex; i < state.appliedLog.length; i++) {
      const pair = TextOperation.transform(op, state.appliedLog[i].op);
      op = pair[0];
    }
    let inverse;
    try {
      inverse = op.invert(state.content);
    } catch {
      return null;
    }
    if (inverse.isNoop()) {
      state.undoStack.pop();
      return null;
    }
    state.undoStack.pop();
    state.redoStack.push({ op: inverse, logIndex: state.appliedLog.length + 1 });
    return commitLocalOp(docId, state, inverse);
  },

  redoDoc(docId) {
    const state = docStates.get(docId);
    if (!state || state.outstanding || state.buffer.length) return null;
    const entry = state.redoStack[state.redoStack.length - 1];
    if (!entry) return null;
    let op = entry.op;
    for (let i = entry.logIndex; i < state.appliedLog.length; i++) {
      const pair = TextOperation.transform(op, state.appliedLog[i].op);
      op = pair[0];
    }
    if (op.isNoop()) {
      state.redoStack.pop();
      return null;
    }
    state.redoStack.pop();
    state.undoStack.push({ op, logIndex: state.appliedLog.length + 1 });
    return commitLocalOp(docId, state, op);
  },

  // ---- presence ----
  updateRemoteCursor(docId, userId, cursor) {
    const state = getState(docId);
    if (!state.remoteCursors) state.remoteCursors = new Map();
    if (!cursor) state.remoteCursors.delete(userId);
    else state.remoteCursors.set(userId, cursor);
  },

  getDocState: (docId) => docStates.get(docId) || null,
}));

function useRoleCheck() {
  return useBoard.getState().role;
}

function sendOutstanding(docId, state, op) {
  state.outstanding = op;
  const baseRev = state.rev;
  armRecoverTimer(docId);
  getSocket().emit(
    "doc:op",
    { documentId: docId, op: op.toJSON(), rev: baseRev },
    (res) => {
      clearRecoverTimer(docId);
      if (res?.error) {
        if (res.stale) recoverDoc(docId);
        else {
          // other errors: the op's fate is unknown — recover via diff
          recoverDoc(docId);
        }
        return;
      }
      useCode.getState().ack(docId, res.rev);
    }
  );
}

// Commit a local op end-to-end: content, log, send pipeline. Returns op.
function commitLocalOp(docId, state, op) {
  try {
    state.content = op.apply(state.content);
  } catch {
    return null;
  }
  logOp(state, op, "local");
  if (state.outstanding) {
    state.buffer.push(op);
  } else {
    sendOutstanding(docId, state, op);
  }
  useCode.getState().bumpTick();
  return op;
}

export function resyncDoc(docId) {
  // Full reset for a doc (used when pending work should be dropped, e.g. the
  // document was reset by a peer). For reconnect/stall recovery prefer
  // recoverDoc — it preserves unsent local edits via diff replay.
  getSocket().emit("doc:sync", { documentId: docId, since: -1 }, (res) => {
    if (res?.error) return;
    const state = getState(docId);
    if (res.reset) {
      const hadPending = !!state.outstanding || state.buffer.length > 0;
      state.content = res.content;
      state.rev = res.rev;
      state.outstanding = null;
      state.buffer = [];
      state.appliedLog = [];
      state.undoStack = [];
      state.redoStack = [];
      if (hadPending) {
        try {
          window.dispatchEvent(
            new CustomEvent("iw-doc-reset", { detail: { docId } })
          );
        } catch {}
      }
    } else {
      // apply missed ops
      for (const entry of res.ops) {
        useCode.getState().applyRemote(docId, entry.op, entry.rev, entry.by);
      }
    }
    useCode.getState().bumpTick();
  });
}

// ---------------------------------------------------------------------------
// socket wiring (once)
// ---------------------------------------------------------------------------
let boundDoc = false;
export function bindDocSocket() {
  if (boundDoc) return;
  boundDoc = true;
  on("doc:op", ({ documentId, op, rev, by }) => {
    const transformed = useCode.getState().applyRemote(documentId, op, rev, by);
    if (transformed) {
      try {
        window.dispatchEvent(
          new CustomEvent("iw-doc-remote", {
            detail: { docId: documentId, op: transformed, by },
          })
        );
      } catch {}
    }
  });
  on("doc:ack", () => {}); // acks arrive via emit callbacks

  // After a reconnect, any in-flight op's ack was lost — recover every doc
  // with pending work (re-airs unsent edits; see recoverDoc above).
  //
  // Delay: socket.io flushes its emit buffer AFTER 'connect' handlers run,
  // so an immediately-issued doc:sync can reach the server BEFORE the
  // buffered doc:op — the sync then reports "nothing missed", the op gets
  // re-aired, and the tie-break duplicates it. Waiting one tick lets the
  // flushed op land first so the sync sees it as an own echo.
  getSocket().on("connect", () => {
    setTimeout(() => recoverAllDocs(), 150);
  });
  // offline → online transitions from the board store also deserve a sweep
  // (covers the case where the socket reconnected before this module bound).
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => recoverAllDocs());
  }
}
