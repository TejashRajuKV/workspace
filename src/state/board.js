"use client";

import { create } from "zustand";
import { applyCanvasOp, makeStyle } from "@/shared/canvasOps";
import { OP, newObjectId } from "@/shared/protocol";
import { getSocket, on, onLocal, emitAck, onConnect, isConnected } from "@/lib/socket";

// ---------------------------------------------------------------------------
// Non-reactive buffers the renderer polls every animation frame. Keeping live
// cursors / marquee / remote selections OUT of React state keeps the board at
// 60fps while collaborators move around.
// ---------------------------------------------------------------------------
export const boardRefs = {
  cursors: new Map(), // userId → { x, y, name, color, view }
  remoteSelections: new Map(), // userId → [objectId]
  marquee: null, // world-space rect while dragging
  changedIds: new Set(), // object ids whose bounds changed → quadtree sync
  fullRebuild: false, // quadtree rebuild flag (reconnect/bootstrap)
  renderTick: 0, // bumped whenever non-object visuals change (presence,
  // remote selections, restores) → the render loop repaints
};

let bound = false;
let syncTimer = null;
let presenceThrottle = 0;
let clientSeq = 0;

function newClientId() {
  clientSeq += 1;
  return `${Date.now().toString(36)}-${clientSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useBoard = create((set, get) => ({
  wsId: null,
  role: "viewer",
  me: null,
  members: [],
  objects: new Map(),
  camera: { x: -200, y: -150, zoom: 1 },
  tool: "select",
  style: makeStyle(),
  selection: [],
  connection: "connecting",
  lastVersion: 0,
  pending: [], // [{ id, op }] submitted or queued, not yet reconciled
  history: { undo: [], redo: [] }, // entries: { apply, inverse }
  clipboard: [],
  objectCountTick: 0,
  historyTick: 0,
  peerCount: 0,
  onlineUsers: [], // users currently present in the room (from presence:state)

  // ---------------- lifecycle ----------------
  reset() {
    boardRefs.cursors.clear();
    boardRefs.remoteSelections.clear();
    set({
      wsId: null,
      me: null,
      role: "viewer",
      members: [],
      objects: new Map(),
      camera: { x: -200, y: -150, zoom: 1 },
      selection: [],
      lastVersion: 0,
      pending: [],
      history: { undo: [], redo: [] },
      peerCount: 0,
      onlineUsers: [],
      connection: "connecting",
    });
  },

  joined({ objects, version, role, me, members, peers }) {
    boardRefs.fullRebuild = true;
    set({
      objects: new Map((objects || []).map((o) => [o.id, o])),
      lastVersion: version || 0,
      role: role || "viewer",
      me: me || get().me,
      members: members || [],
      peerCount: peers?.length || 0,
      objectCountTick: get().objectCountTick + 1,
    });
  },

  // ---------------- outgoing local operations ----------------
  // Every local edit funnels through here:
  //   optimistic local apply → history (inverse ops) → send (or queue).
  // historyEntries: array parallel to ops ({ apply, inverse } | null).
  submitOps(ops, historyEntries = null) {
    const s = get();
    if (!s.wsId || s.role === "viewer" || !ops.length) return;
    const objects = s.objects;

    const prepared = [];
    const entries = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const existed = objects.has(op.oid);
      const ok = applyCanvasOp(objects, op, s.me?.id || "me", Date.now());
      const meaningful = ok || (op.type === OP.CREATE && !existed);
      if (!meaningful) continue;
      prepared.push({ id: newClientId(), op });
      if (historyEntries?.[i]) entries.push(historyEntries[i]);
      boardRefs.changedIds.add(op.oid);
    }
    if (!prepared.length) return;

    const history = { undo: [...s.history.undo, ...entries], redo: [] };
    if (history.undo.length > 300) history.undo.splice(0, history.undo.length - 300);

    set({
      pending: [...s.pending, ...prepared],
      history,
      historyTick: s.historyTick + 1,
      objectCountTick: s.objectCountTick + 1,
    });
    flushPending();
  },

  // Per-user undo/redo via inverse operations (docs/synchronization.md).
  undo() {
    const s = get();
    const entry = s.history.undo[s.history.undo.length - 1];
    if (!entry) return;
    set({
      history: {
        undo: s.history.undo.slice(0, -1),
        redo: [...s.history.redo, entry],
      },
      historyTick: s.historyTick + 1,
    });
    submitDirect(entry.inverse);
  },

  redo() {
    const s = get();
    const entry = s.history.redo[s.history.redo.length - 1];
    if (!entry) return;
    set({
      history: {
        undo: [...s.history.undo, entry],
        redo: s.history.redo.slice(0, -1),
      },
      historyTick: s.historyTick + 1,
    });
    submitDirect(entry.apply);
  },

  // ---------------- selection / tool / style / camera ----------------
  setTool: (tool) => set({ tool }),
  setStyle: (patch) => set({ style: { ...get().style, ...patch } }),
  setCamera: (camera) => set({ camera }),
  setSelection: (selection) => set({ selection }),
  setClipboard: (clipboard) => set({ clipboard }),
  resetHistory: () => set({ history: { undo: [], redo: [] }, historyTick: get().historyTick + 1 }),

  // Push a history entry for an op that was already applied incrementally
  // during a drag (the drag emitted throttled partial ops without history).
  pushHistoryEntry(entry) {
    const s = get();
    set({
      history: { undo: [...s.history.undo, entry], redo: [] },
      historyTick: s.historyTick + 1,
    });
  },

  // Send an op to the server WITHOUT applying it locally (used during drags:
  // the payload was already mutated directly for 60fps feedback).
  emitWithoutLocalApply(op) {
    const s = get();
    if (!s.wsId || s.role === "viewer") return;
    set({ pending: [...s.pending, { id: newClientId(), op }] });
    flushPending();
  },

  // ---------------- reconciliation (reconnect / version gaps) ----------------
  requestSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(async () => {
      syncTimer = null;
      const s = get();
      if (!s.wsId) return;
      const res = await emitAck("sync:request", { since: s.lastVersion }, 15000);
      if (res.error || !get().wsId) return;
      reconcile(res);
    }, 60);
  },
}));

// Submit without touching history (undo/redo themselves).
function submitDirect(op) {
  const s = useBoard.getState();
  if (!s.wsId || s.role === "viewer" || !op) return;
  const ok = applyCanvasOp(s.objects, op, s.me?.id || "me", Date.now());
  if (!ok) return;
  useBoard.setState({
    pending: [...s.pending, { id: newClientId(), op }],
    objectCountTick: s.objectCountTick + 1,
  });
  flushPending();
}

export function flushPending() {
  const s = useBoard.getState();
  if (!s.wsId || !isConnected() || !s.pending.length) return;
  const payload = s.pending.map(({ id, op }) => ({ id, ...op }));
  emitAck("canvas:op", { ops: payload }, 20000).then((res) => {
    if (res.error) {
      if (res.error === "timeout") useBoard.getState().requestSync();
      return;
    }
    const st = useBoard.getState();
    const ackedIds = new Set(payload.map((p) => p.id));
    useBoard.setState({
      pending: st.pending.filter((p) => !ackedIds.has(p.id)),
      lastVersion: Math.max(st.lastVersion, res.version || 0),
    });
  });
}

// Merge a sync:response into local state:
//  1. pending ops already applied server-side (clientId in the missed range)
//     are dropped — their effect arrives via state replacement
//  2. every object touched by the missed range is replaced with the server's
//     canonical record (or removed if deleted server-side)
//  3. remaining (unacked) pending ops are re-applied on top, then resubmitted
function reconcile(res) {
  const s = useBoard.getState();
  if (!s.wsId || typeof res.version !== "number") return;
  const objects = s.objects;
  const serverOps = res.ops || [];

  const ackedClientIds = new Set(serverOps.map((o) => o.clientId).filter(Boolean));
  const remainingPending = s.pending.filter((p) => !ackedClientIds.has(p.id));

  if (res.full) {
    const fresh = new Map((res.objects || []).map((o) => [o.id, o]));
    for (const { op } of remainingPending) applyCanvasOp(fresh, op, s.me?.id || "me", Date.now());
    boardRefs.fullRebuild = true;
    useBoard.setState({
      objects: fresh,
      lastVersion: res.version,
      pending: remainingPending,
      objectCountTick: s.objectCountTick + 1,
    });
    flushPending();
    return;
  }

  const replaced = new Set();
  for (const rec of res.objects || []) {
    if (rec.deleted) objects.delete(rec.id);
    else
      objects.set(rec.id, {
        id: rec.id,
        type: rec.type,
        payload: rec.payload,
        z: rec.z,
        createdBy: rec.createdBy,
      });
    boardRefs.changedIds.add(rec.id);
    replaced.add(rec.id);
  }
  // Re-apply pending effects ONLY on replaced objects: their local state was
  // reset to the server's pre-pending record, so the optimistic effects must
  // be replayed. Non-replaced objects still carry their pending effects.
  for (const { op } of remainingPending) {
    if (!replaced.has(op.oid)) continue;
    applyCanvasOp(objects, op, s.me?.id || "me", Date.now());
    boardRefs.changedIds.add(op.oid);
  }
  useBoard.setState({
    lastVersion: res.version,
    pending: remainingPending,
    objectCountTick: s.objectCountTick + 1,
  });
  flushPending();
}

// Throttled presence publishing (≤ 20 Hz).
export function sendPresence(patch) {
  const now = Date.now();
  if (now - presenceThrottle < 50) return;
  presenceThrottle = now;
  try {
    getSocket().emit("presence:update", patch);
  } catch {}
}

// ---------------------------------------------------------------------------
// socket wiring — called once per app lifetime
// ---------------------------------------------------------------------------
export function bindBoardSocket() {
  if (bound) return;
  bound = true;

  on("canvas:op", ({ op, version, by }) => {
    const st = useBoard.getState();
    if (typeof version !== "number") return;
    if (version === st.lastVersion + 1) {
      if (op.type === OP.DELETE) {
        boardRefs.remoteSelections.forEach((ids, uid) => {
          if (ids.includes(op.oid))
            boardRefs.remoteSelections.set(uid, ids.filter((x) => x !== op.oid));
        });
      }
      applyCanvasOp(st.objects, op, by, Date.now());
      boardRefs.changedIds.add(op.oid);
      useBoard.setState({ lastVersion: version, objectCountTick: st.objectCountTick + 1 });
    } else if (version > st.lastVersion + 1) {
      // gap — the op's effect arrives via sync reconciliation
      useBoard.getState().requestSync();
    }
    // version ≤ lastVersion → stale duplicate, ignore
  });

  on("canvas:ack", ({ results }) => {
    const st = useBoard.getState();
    let lastVersion = st.lastVersion;
    const acked = new Set();
    let failed = false;
    for (const r of results || []) {
      if (r.id) acked.add(r.id);
      if (r.ok && typeof r.version === "number") lastVersion = Math.max(lastVersion, r.version);
      if (!r.ok) failed = true;
    }
    useBoard.setState({
      lastVersion,
      pending: st.pending.filter((p) => !acked.has(p.id)),
    });
    // a rejected op leaves an unapplied local effect → reconcile against the
    // server's canonical state right away
    if (failed) useBoard.getState().requestSync();
  });

  on("sync:response", reconcile);

  onLocal("connection", (state) => {
    useBoard.setState({ connection: state });
    const st = useBoard.getState();
    if (state === "online" && st.wsId) {
      // fresh socket → rejoin room, reconcile, flush the offline queue
      emitAck("ws:join", { workspaceId: st.wsId }, 10000).then((res) => {
        if (res.error) return;
        useBoard.getState().requestSync();
        flushPending();
      });
    }
  });

  onConnect(() => {
    const st = useBoard.getState();
    if (st.wsId) emitAck("ws:join", { workspaceId: st.wsId }, 10000).then(() => {});
  });

  // -------- presence --------
  on("presence:state", ({ users }) => {
    if (!users) return;
    const me = useBoard.getState().me;
    boardRefs.cursors.clear();
    boardRefs.remoteSelections.clear();
    let count = 0;
    const online = new Map(); // userId → user (deduped across tabs)
    for (const rec of Object.values(users)) {
      if (!rec?.user) continue;
      count++;
      online.set(rec.user.id, rec.user);
      if (me && rec.user.id === me.id) continue;
      const sid = rec.user.id;
      boardRefs.cursors.set(sid, {
        x: rec.cursor?.x ?? null,
        y: rec.cursor?.y ?? null,
        name: rec.user.username,
        color: rec.user.color,
        view: rec.view || "board",
      });
      if (rec.selection?.length) boardRefs.remoteSelections.set(sid, rec.selection);
    }
    boardRefs.renderTick += 1; // remote cursors/selections → repaint
    useBoard.setState({ peerCount: Math.max(0, count - (me ? 1 : 0)), onlineUsers: [...online.values()] });
  });

  on("ws:restored", ({ toVersion, by }) => {
    try {
      window.dispatchEvent(new CustomEvent("iw-restored", { detail: { toVersion, by } }));
    } catch {}
  });
}
