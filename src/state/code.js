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
    // fetch authoritative state (in case another client edited before us)
    getSocket().emit("doc:open", { documentId: docId }, (res) => {
      if (res?.error) return;
      const st = get();
      const state = getState(docId, res.content, res.rev);
      if (state.content !== res.content && !state.outstanding && !state.buffer.length) {
        state.content = res.content;
        state.rev = res.rev;
        st.bumpTick();
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
      // gap → resync this document
      resyncDoc(docId);
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
      resyncDoc(docId);
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
  getSocket().emit(
    "doc:op",
    { documentId: docId, op: op.toJSON(), rev: baseRev },
    (res) => {
      if (res?.error) {
        if (res.stale) resyncDoc(docId);
        // on other errors: drop outstanding (state reconciles via resync)
        state.outstanding = null;
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
}
