# Synchronization Design

This is the research core of the project. Two very different data models live
in the same workspace — an **object graph** (canvas) and **linear text**
(documents) — and each gets the synchronization strategy its structure
actually needs.

---

## 1. Canvas: server-sequenced total order + commutative deltas

### The problem

N clients mutate a shared set of objects (create, delete, move, resize,
restyle) under latency, and must converge to byte-identical state without
central UI locking.

### The design

Every mutation is an **operation** (never "send the whole board"). The
collaboration service is the single **sequencer**:

```
client op ─► validate ─► version = ++ws.counter (BEGIN IMMEDIATE tx)
        ─► apply to canvas_objects (materialized state)
        ─► INSERT INTO operations (append-only log) ─► COMMIT
        ─► broadcast {op, version} + ack {opId, version} to the sender
```

All clients apply operations strictly in version order. This is **total-order
broadcast**: every replica applies the same operations in the same order, so
replicas converge (state-machine replication). No vector clocks are needed for
ordering because the sequencer defines the order; the version number doubles
as the gap detector (a client seeing version N+2 while expecting N+1 knows it
missed something and reconciles).

### Op semantics are chosen so concurrent edits behave well

| op | payload | concurrent semantics |
|---|---|---|
| `move` | **delta** (dx, dy) | **commutative** — two users dragging the same object both apply; drags merge additively instead of clobbering |
| `resize` / `rotate` / `style` / `text` / `zorder` | absolute | last-writer-wins **in server order** — deterministic, no lost-update ambiguity about *who* won |
| `create` / `delete` | record / tombstone | idempotent; create-then-delete races resolve by server order |

Delta-moves are the CRDT-flavored piece: addition is commutative, associative
and has an inverse, so position behaves like a PN-counter per axis. Absolute
fields use sequenced LWW. Together: **convergence without interactive
transformation of object graphs**, which is where OT for spatial data gets
notoriously hard.

### Offline / reconnect (the rebase rule)

A disconnected client keeps applying operations locally (optimistic) and
queues them. On reconnect:

1. **Reconcile against server state, not op replay.** The client submits its
   queued ops (they get sequenced like any other op), then requests
   `ops since lastVersion`. The response contains the missed ops **and** the
   server's canonical record for *every object touched in that range*.
2. The client replaces those objects wholesale with the server records —
   this erases any divergence — and re-applies its still-unacked pending ops
   **only on the replaced objects** (their optimistic effects were reset;
   non-replaced objects still carry them). Ops the server rejected (e.g. a
   move on an object deleted while offline) no-op on both sides, so both
   reject conditions coincide.

The result provably reproduces the server's canonical state + pending
effects without replaying history from scratch. Beyond 2000 missed ops the
server switches to a full-state refresh (same reconciliation path).

Trigger-happy edge cases are handled: rejected ops trigger an immediate
re-sync; version gaps trigger `sync:request`; a full refresh re-applies
pending ops afterwards.

### Collaborative undo/redo

You cannot "remove the last global operation" — another user's operation may
sit on top of yours. Instead, undo submits the **inverse of your own
operation** as a brand-new, versioned, broadcast operation:

- `create ↔ delete` (delete captures the full record first)
- `move(+d) ↔ move(−d)`
- absolute setters restore the previously captured value

Stacks are per-user; redo is the same machinery with the entry's forward op.
Drag interactions are chunked into throttled live ops (~20 Hz, no history)
plus one aggregate history entry at pointer-up, so undo granularity matches
the user's gesture, not the network tick.

---

## 2. Text: classic Operational Transformation (Jupiter/ShareJS model)

### Why OT here and not the canvas strategy

Text is a **linear sequence with positional intent**: "insert X at offset 12"
means something different after another user inserts 5 chars at offset 3.
Deltas are not commutative in intent, and absolute indices can't be stored —
the operations must be **transformed** against concurrent operations. This is
exactly what OT was built for, and for linear text the transform functions
are small, well-understood and testable.

(Why not CRDT (RGA/Yjs)? A text CRDT would remove the central sequencer but
adds tombstone metadata per character and far more intricate merge logic.
With a single trusted service instance, server-side OT gives identical
guarantees with a fraction of the state. This trade-off is documented as a
deliberate decision.)

### The model

An operation is a sequence of components over the current document:
`retain(n)` · `insert(s)` · `delete(n)`, with baseLength/targetLength
invariants. The shared engine (`src/shared/ot.js`) implements `apply`,
`invert`, `compose` and `transform` — the same code runs in the browser and
in the service.

- **Server** = single sequencer per document. A client submits `{op, rev}`;
  the server transforms it against every op that happened since `rev`, then
  applies, logs (`document_operations`) and broadcasts the transformed op.
- **Client** runs the single-outstanding pipeline: one op in flight; newer
  local edits queue in a buffer; on ack, the buffer composes into the next
  in-flight op; on remote op, the client transforms its in-flight + buffered
  ops against it and applies the transformed remote.
- Lagging clients beyond 400 ops get a full content reset instead of an op
  flood; stale revisions are rejected with a resync hint.

Determinism note: `transform`'s insert-vs-insert tie-break compares the
inserted strings lexicographically, so both argument orders agree — the test
suite asserts this symmetry plus TP1 on hundreds of random pairs.

### Collaborative undo for text

Undo = inverse op **transformed forward** through every operation that landed
after it (tracked in a per-document linear log). The transformed inverse is
submitted as a normal local op. This is ShareJS-style undo and preserves
convergence; it is disabled while an op is in flight to keep the invariant
simple.

---

## 3. Presence

Presence is ephemeral and never persisted. Clients publish
`{cursor, selection, view, editor}` throttled to ≤20 Hz; the service keeps an
in-memory room map and broadcasts the aggregated state at a fixed 15 Hz per
room. Live cursors/selections live in **non-reactive buffers** the canvas
renderer polls each frame — React never re-renders because someone moved a
mouse.

---

## 4. Persistence: event sourcing with snapshots

- `operations` is the append-only log; `canvas_objects` is the materialized
  state (fast loads, no replay to open a workspace).
- Every 100 versions the service snapshots `{objects, docs}` into
  `snapshots` (last 20 retained).
- **Restore** = latest snapshot ≤ version + replay of subsequent ops → diff
  against current state → the diff is emitted as regular (broadcast,
  versioned) operations. Restore is therefore itself collaborative and
  consistent — every client converges on it like any other edit.

---

## 5. Why this architecture (summary of the research questions)

| question | answer |
|---|---|
| How do clients modify shared state without losing changes? | server-sequenced ops; deltas commute, absolutes LWW in sequencer order |
| CRDT or OT? | OT for text (linear, central sequencer available); sequenced-delta model for canvas (CRDT-flavored merge where it pays off) |
| Efficient rendering of huge canvases? | quadtree spatial index + viewport culling + dirty-flag rAF (see architecture.md) |
| Disconnected clients? | op queue + object-level state reconciliation on reconnect |
| Collaborative undo? | per-user inverse ops (canvas), transformed inverses (text) |
| Minimizing WebSocket traffic? | throttled presence, delta ops, batched acks, ~15 Hz aggregation |
| Efficient persistence? | append-only log + materialized state + periodic snapshots |
| Replay cost? | bounded — snapshots bound restore replay to ≤100 ops in the common case |
