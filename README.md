# Real-Time Collaborative Infinite Workspace

> A real-time collaborative development environment combining an infinite
> whiteboard and a collaborative code editor through a **custom synchronization
> engine** — OT for text, server-sequenced operations with commutative deltas
> for the canvas, event sourcing + snapshots for persistence.

*Built in **100% plain JavaScript** (zero TypeScript), **no Docker**, **no AI APIs** — exactly per the project constraints.*

---

## Table of contents

1. [What is this?](#1-what-is-this)
2. [Feature checklist](#2-feature-checklist)
3. [Architecture](#3-architecture)
4. [The synchronization engine](#4-the-synchronization-engine)
5. [Tech stack](#5-tech-stack)
6. [How to run it](#6-how-to-run-it)
7. [How to use it (user guide)](#7-how-to-use-it-user-guide)
8. [Testing](#8-testing)
9. [Load / stress testing](#9-load--stress-testing)
10. [API summary](#10-api-summary)
11. [Database](#11-database)
12. [Project structure](#12-project-structure)
13. [Security model](#13-security-model)
14. [Troubleshooting](#14-troubleshooting)
15. [Deeper docs](#15-deeper-docs)

---

## 1. What is this?

Imagine a team building software. Instead of juggling separate apps
(whiteboard + editor + file explorer + terminal), everything lives in **one
shared workspace**, synchronized in real time between any number of browsers:

- an **infinite whiteboard** — pan and zoom without limits, draw shapes,
  sketch freehand, drop sticky notes, link ideas with connectors;
- a **collaborative code editor** — Monaco with a virtual file tree, tabs,
  syntax highlighting, live remote cursors;
- a **terminal** — run JavaScript and Python files straight from the
  workspace and watch output stream in;
- a **time machine** — every change is an operation in an append-only log
  with periodic snapshots, so you can browse and restore any past version;
- **real-time collaboration** — live cursors, selections, presence avatars,
  offline mode with automatic reconciliation, conflict resolution.

The central engineering challenge this project solves:

> **Maintaining consistent shared spatial and textual state across multiple
> independent clients under concurrent modifications, network delays,
> disconnections and reconnections.**

## 2. Feature checklist

### Whiteboard
- Infinite canvas — world coordinates, pan (hand tool / middle-drag / space-drag), zoom 0.02×–8× anchored at the cursor
- Objects: rectangle, ellipse, line, arrow, freehand (RDP-simplified), text, sticky notes, images (pasted as data URLs), connectors that stay attached to the objects they link
- Select (click / marquee / shift-multi), move, 8-handle resize with rotation-aware anchor math, rotate with 15° snapping, nudge with arrow keys
- Copy / paste / duplicate (Ctrl+C / V / D), delete, bring-to-front / send-to-back
- Style bar: fill palette, stroke palette, stroke width, font size
- Per-user **undo/redo via inverse operations** (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) — works correctly alongside other people's edits
- Adaptive dot grid, viewport culling through a **quadtree spatial index**, dirty-flag 60 fps render loop

### Real-time collaboration
- Multi-user rooms per workspace, live cursors with name tags, remote selection highlights in user colors, presence avatars
- Connection status indicator with automatic rejoin + reconciliation
- **Offline mode** — keep working while disconnected; operations queue locally and reconcile against server state on reconnect (no full reload)
- Conflict resolution — see [§4](#4-the-synchronization-engine)
- Roles: **owner / editor / viewer**, enforced server-side on every operation

### Code workspace
- Monaco editor (vendored locally into `public/monaco` — no CDN needed)
- Virtual file tree: create / rename / move / delete files and folders
- Editor tabs, JavaScript / Python / JSON / HTML / CSS / Markdown syntax highlighting
- **Live collaborative editing** via Operational Transformation, remote cursors + selections with name labels
- OT-aware undo/redo inside the editor (Monaco's own stack is replaced)

### Terminal & execution
- JavaScript (node) and Python (python3) execution from workspace files
- Streaming stdout/stderr, 8 s timeout, 128 KB output cap, temp-dir isolation, minimal environment, per-user and global concurrency limits — **no Docker**
- Terminal commands: `run <file>` · `node <file.js>` · `python <file.py>` · `ls` · `clear` · `help`

### Persistence & history
- Every canvas change is an operation in an **append-only log** (event sourcing)
- Full-state **snapshots every 100 operations**
- **Version history panel**: who did what, when — with one-click **restore** to any version (restore itself is a normal synchronized edit, so all clients converge on it)
- Workspace survives browser refresh, server restart, disconnect and reconnect

## 3. Architecture

```
                     ┌────────────── Browsers ──────────────┐
                     │  SPA (auth → dashboard → workspace)  │
                     │  canvas engine · Monaco · terminal   │
                     └───────────────┬──────────────────────┘
                        REST │            │ WebSocket
                             ▼            ▼ (?XTransformPort=3003 via gateway)
        ┌──────────────────────────┐   ┌────────────────────────────────┐
        │ Next.js :3000            │   │ Collab service :3003 (Node)    │
        │  SPA + REST API          │   │  canvas sync engine (sequencer)│
        │  auth · workspaces ·     │   │  document OT · presence        │
        │  files · history · join  │   │  snapshots · restore · exec    │
        └───────────┬──────────────┘   └───────────────┬────────────────┘
                    │ Prisma                           │ node:sqlite (raw SQL)
                    ▼                                  ▼
        ┌─────────────────────────────────────────────────────────────┐
        │        one SQLite database, WAL mode (db/custom.db)         │
        │  users · sessions · workspaces · members · documents        │
        │  canvas_objects · operations · document_operations ·        │
        │  workspace_state · snapshots                                │
        └─────────────────────────────────────────────────────────────┘
                    ▲
                    │ internal HTTP :3004 (localhost only, token-authed)
        restore requests · filesystem-change broadcasts · health
```

Why two runtimes? The Next.js dev server runs under **Bun** (fast, platform-managed),
but Bun cannot load native SQLite addons (`better-sqlite3` crashes, `node:sqlite`
is unavailable) — so the realtime hot path runs in a plain **Node** process using
the built-in `node:sqlite`, sharing the same WAL database file. Each runtime owns
disjoint tables; short write transactions + WAL + busy-retry handle cross-process
contention. Full details: [`docs/architecture.md`](docs/architecture.md).

## 4. The synchronization engine

This is the heart of the project (full write-up: [`docs/synchronization.md`](docs/synchronization.md)).

### Canvas — server-sequenced total order + commutative deltas

Every mutation is a small **operation** (`create`, `delete`, `move{dx,dy}`,
`resize`, `rotate`, `style`, `text`, `zorder`) — never "send the whole board".
The collaboration service is the single **sequencer**:

```
validate → version = ++ws.counter (transaction)
        → apply to canvas_objects (materialized state)
        → append to operations log
        → broadcast {op, version} + ack to sender
```

All clients apply operations **strictly in version order** (total-order
broadcast ⇒ state-machine replication ⇒ convergence). Operation semantics are
chosen deliberately:

- `move` carries a **delta** — addition is commutative, so two people dragging
  the same object **both** apply (like a CRDT counter) instead of clobbering;
- all other fields are absolute — deterministic last-writer-wins *in server order*.

**Offline/reconnect**: the client queues ops locally, then on reconnect
submits them and requests `ops since lastVersion` — the server responds with
the missed ops **plus the canonical record of every touched object**, the
client replaces those objects wholesale, re-applies its still-unacked pending
ops on top, and converges without a full reload. Beyond 2000 missed ops it
falls back to a full-state refresh through the same reconciliation path.

**Collaborative undo** submits the **inverse of your own operation** as a new
versioned broadcast op (`create↔delete`, `move(+d)↔move(−d)`, absolute
setters restore captured values) — never "delete the last global op".

### Text — classic Operational Transformation

Text has positional intent, so it gets real OT (Jupiter/ShareJS model).
`src/shared/ot.js` implements `TextOperation` (retain/insert/delete
components) with `apply`, `invert`, `compose`, `transform` — the same module
runs in the browser and the service. The server transforms each submission
against everything that happened since the client's revision; clients run the
single-outstanding pipeline (one op in flight, buffer behind it, compose on
ack, transform on remote). Insert-vs-insert ties break lexicographically so
transform is deterministic regardless of delivery order. Undo = inverse
transformed forward through the op log.

### Persistence = event sourcing

`operations` is the log; `canvas_objects` is materialized state (open a
workspace with one query, never a replay). Snapshots every 100 versions bound
restore replay; restore diffs state@version against current state and
re-broadcasts the difference as ordinary operations.

## 5. Tech stack

| layer | technology |
|---|---|
| Frontend | React 19 (Next.js 16 App Router), **plain JSX**, Tailwind CSS 4, zustand, lucide-react, Monaco Editor (self-hosted), Canvas 2D |
| Realtime | Socket.IO 4 (own Node mini-service, reached via the gateway) |
| Backend | Next.js Route Handlers (Bun runtime) + standalone Node service |
| Database | SQLite (WAL) — Prisma on the Next side, `node:sqlite` on the service |
| Auth | scrypt password hashing, httpOnly session cookies |
| Execution | controlled child processes (node / python3) |
| Language | **JavaScript only** — no TypeScript anywhere (all configs converted: `jsconfig.json`, `next.config.mjs`, …) |
| Testing | `node:test` (18 tests), custom socket.io stress harness |

## 6. How to run it

### Prerequisites

- Node.js 22+ (built with 24) — for the collab service (`node:sqlite`)
- [Bun](https://bun.sh) — for the Next.js dev server
- Python 3 — optional, only for running `.py` files

### Step-by-step

```bash
# 1 ─ install dependencies (Next.js side)
bun install

# 2 ─ create the database schema (SQLite at db/custom.db)
bun run db:push

# 3 ─ start the collaboration service (port 3003 + internal 3004)
cd mini-services/collab-service
bun install          # socket.io for the service
node index.js        # keep this running; or: bun run dev (node --watch)
cd ../..

# 4 ─ start the web app (port 3000)
bun run dev

# 5 ─ open the app
#    local:    http://localhost:3000
#    sandbox:  use the Preview panel / "Open in New Tab"
```

> On the managed sandbox the platform runs `bun run dev` automatically and
> also auto-starts every `mini-services/*` package that has a `dev` script —
> so steps 3–4 usually happen on their own. The gateway exposes **one URL**:
> normal traffic goes to Next.js, anything with `?XTransformPort=3003` is
> proxied to the collab service (already wired into `src/lib/socket.js`).

### Verifying it works

```bash
curl http://localhost:3000/                      # → 200 (SPA)
curl -X POST http://127.0.0.1:3004/internal/health \
     -H 'x-internal-token: iw-internal-token'    # → {"ok":true,...}
node --test tests/ot.test.js tests/canvas.test.js tests/sync.test.js
node scripts/stress.js 5 20                      # quick load test
```

### Environment variables (optional)

| variable | default | purpose |
|---|---|---|
| `DATABASE_URL` | `file:/home/z/my-project/db/custom.db` | SQLite file (Prisma side) |
| `DATABASE_PATH` | `<repo>/db/custom.db` | same file (service side) |
| `COLLAB_SERVICE_URL` | `http://127.0.0.1:3004` | internal endpoints (Next → service) |
| `INTERNAL_TOKEN` | `iw-internal-token` | shared secret for internal endpoints |

## 7. How to use it (user guide)

### Accounts & workspaces

1. Open the app → **Create account** (username 3–24 chars, password ≥ 6).
2. On the dashboard: **New workspace** to create one, or paste a workspace
   ID into **Join by ID** to join someone else's (you become an editor).
3. Click a workspace card to open it. To collaborate, share the workspace ID
   (visible on the card) with a second account — open the app in another
   browser, join, and everything syncs live.

### The board (left pane)

- **Tools** (left rail, keyboard shortcuts in tooltips): select (V), pan (H),
  rectangle (R), ellipse (O), line (L), arrow (A), freehand (P), text (T),
  sticky (N), connector (C), eraser (E), image upload.
- Draw by dragging; click the **text tool** then click the board to type;
  double-click a text/sticky to edit it; with the **connector tool**, click
  object A then object B to link them (connectors follow the objects).
- **Style bar** (top): undo/redo, fill & stroke palettes, stroke width, font
  size, layering, duplicate, delete — apply to the current selection.
- **Zoom controls** (bottom-right) or mouse wheel; space-drag or hand tool to pan.
- Live cursors of teammates appear with name tags; their selections glow in
  their color.

### The code panel (right pane)

- File tree (left): `+` buttons create files/folders; right-click for
  rename/move/delete; click a file to open it in a tab.
- Edit together — remote users' cursors and selections appear inside the
  editor. Ctrl+Z / Ctrl+Shift+Z are OT-aware.
- **▶ Run** (top bar or terminal) executes the active file: `.js` via node,
  `.py` via python3. Output streams into the terminal.

### The terminal (bottom pane)

```
$ ls
$ run main.js          # infers language from extension
$ python tools.py
$ clear
```

### History & restore

Click **History** (top bar): the operation log with author, summary and
version number. Hover → **↺** restores the whole board to that version —
the restore is itself a synchronized operation visible to everyone.

### Offline behavior

Disconnect (or stop the service): the status pill turns amber and you can
keep drawing/editing. Everything queues locally. On reconnect the app
rejoins, reconciles against the server's canonical state and flushes the
queue — no duplicate effects, no reload.

## 8. Testing

```bash
node --test tests/ot.test.js tests/canvas.test.js tests/sync.test.js
```

| suite | what it proves |
|---|---|
| `ot.test.js` | apply/base-target invariants · `invert` identity · **compose algebraic identity** · **TP1 convergence** (100 random pairs) · **tie-break symmetry** (argument-order independence) · caret transforms (incl. inside deleted spans) |
| `canvas.test.js` | coordinate round-trips at any zoom · anchored zoom · quadtree insert/query/remove incl. 3000-object subdivision · canvas op semantics · **move-delta commutativity** · op validation & sanitization |
| `sync.test.js` | total-order convergence for random op streams (40 trials × 3 clients) · **offline-rebase convergence** (60 trials) · **two-client OT pipeline convergence** (50 trials with in-flight ops, acks and resyncs) |

These tests caught and fixed three real bugs during development (transform
trailing-insert handling, tie-break determinism, reconcile double-apply).

## 9. Load / stress testing

```bash
node scripts/stress.js [users] [opsPerUser]
# e.g.
node scripts/stress.js 10 50
```

Creates real users + workspace over REST, joins N Socket.IO clients, submits
create+move op pairs, and reports:

```
operations applied 1000 (523/s)
failures           0
ack latency  p50 / p95 / p99   19 / 67 / 79 ms
final version      1000 (expected 1000)   ← total-order check
objects on server  500                     ← durability check
✓ STRESS PASS
```

The final version must equal `users × ops × 2` exactly (no lost/duplicated
operations) and every created object must exist — this verifies the
sequencer, persistence and materialized state end-to-end.

## 10. API summary

Full reference: [`docs/api.md`](docs/api.md).

**REST** (cookie session): `POST /api/auth` (register/login) ·
`GET/DELETE /api/auth/session` · `GET/POST /api/workspaces` ·
`GET/PATCH/DELETE /api/workspaces/:id` · `POST /api/workspaces/:id/join` ·
`GET /api/workspaces/:id/bootstrap` · `POST /api/workspaces/:id/files` ·
`PATCH/DELETE /api/workspaces/:id/files/:fileId` ·
`GET /api/workspaces/:id/versions` · `POST /api/workspaces/:id/restore`.

**Socket.IO**: `ws:join/leave` · `canvas:op` / `canvas:ack` / `canvas:op` (broadcast) ·
`sync:request` → `sync:response` · `doc:open` · `doc:op` (submit + broadcast) ·
`doc:sync` · `presence:update` → `presence:state` · `exec:start` →
`exec:started` / `exec:output` / `exec:end` · `fs:changed` · `ws:restored`.

## 11. Database

Full schema & rationale: [`docs/database.md`](docs/database.md).

- **Identity/metadata** (Prisma-owned): `users`, `sessions`,
  `workspaces`, `workspace_members`, `documents` (the virtual file system).
- **Realtime core** (service-owned): `canvas_objects` (materialized state),
  `operations` (append-only canvas log, per-workspace `version`,
  `client_id` for idempotent resubmission), `workspace_state` (version
  counters), `document_operations` (per-doc OT log), `snapshots`.
- Epoch timestamps are 64-bit (`BigInt`) — ms values overflow 32-bit `Int`.

## 12. Project structure

```
├── src/
│   ├── app/                        # Next.js App Router
│   │   ├── page.js                 # SPA root (auth → dashboard → workspace)
│   │   ├── layout.js · globals.css
│   │   └── api/                    # REST route handlers (auth, workspaces,
│   │                               #   files, bootstrap, versions, restore)
│   ├── shared/                     # sync engine core — shared client+server
│   │   ├── protocol.js             #   op types, validation, limits
│   │   ├── ot.js                   #   TextOperation: apply/invert/compose/transform
│   │   └── canvasOps.js            #   op application, bounds, rebase merge
│   ├── state/                      # zustand stores
│   │   ├── session.js              #   view/user state
│   │   ├── board.js                #   canvas objects, ops queue, reconcile
│   │   └── code.js                 #   per-doc OT pipeline, undo
│   ├── lib/                        # db (prisma), auth, socket, serviceClient
│   └── components/workspace/
│       ├── canvas-engine/          # camera, quadtree, geometry, renderer,
│       │                           #   tools (interactions), history
│       ├── CanvasBoard.jsx         # rAF loop + inline text editor
│       ├── CodePanel.jsx           # Monaco + tabs + remote cursors
│       ├── FileExplorer.jsx · Terminal.jsx · TopBar.jsx
│       ├── Toolbar.jsx · HistoryPanel.jsx
│       └── WorkspaceView.jsx · DashboardView.jsx · AuthView.jsx
├── mini-services/collab-service/   # realtime service (Node, port 3003)
│   ├── index.js                    #   socket.io wiring + internal HTTP
│   ├── canvasSync.js               #   sequencer, state materialization, restore
│   ├── docSync.js                  #   server-side OT
│   ├── presence.js · execution.js · db.js
├── public/monaco/                  # self-hosted Monaco (no CDN)
├── docs/                           # architecture · synchronization · api · database
├── tests/                          # node:test suites
├── scripts/stress.js               # load generator
├── prisma/schema.prisma            # full database schema
└── README.md
```

## 13. Security model

- **Identity** comes only from the httpOnly session cookie (scrypt-hashed
  passwords). Sockets authenticate through the same cookie at handshake —
  clients never declare a userId.
- **Authorization** is checked server-side on every event: room membership on
  `ws:join`, role (owner/editor/viewer) on every mutation, execution, restore.
- **Validation** on every operation: type whitelists, payload size caps
  (text 20 KB, image 600 KB, payload 700 KB), coordinate bounds, file-path
  traversal prevention, style sanitization.
- **Rate limiting**: per-socket token buckets (canvas ops, doc ops, presence).
- **Execution sandboxing**: allowlisted languages, temp-dir materialization,
  no shell, minimal env, SIGKILL timeout, output caps, concurrency limits.
  (This is a trusted-user local feature, not a public sandbox — without
  containers, strong multi-tenant isolation is explicitly out of scope.)
- **Internal endpoints** (:3004) are bound to localhost and token-authed.

## 14. Troubleshooting

| symptom | cause & fix |
|---|---|
| `better-sqlite3 … NAPI FATAL` crash | expected under Bun — this project deliberately uses `node:sqlite` (Node side) + Prisma (Bun side). Don't load better-sqlite3 from Next.js code. |
| collab service fails: `port: 3003` in use | a stale instance is running — `pkill -f "node index.js"` and start it again. |
| `PrismaClient` error `Expected Int, provided BigInt` (or vice versa) | stale generated client — `bun run db:generate`, then restart the dev server. |
| workspace opens but is empty / versions diverge between UI and API | two service processes on one DB after a schema migration — kill all `node index.js` processes, delete `db/custom.db*`, `bun run db:push`, start one service, restart `bun run dev`. |
| terminal says `Server is busy` | 4 concurrent executions are running — wait for one to finish (8 s timeout max). |
| "Workspace not found or access denied" on join | the ID is wrong, or you're not authenticated — the app calls the idempotent `join` endpoint automatically when opening. |

## 15. Deeper docs

- [`docs/architecture.md`](docs/architecture.md) — components, runtime topology, execution sandboxing, security model
- [`docs/synchronization.md`](docs/synchronization.md) — **the research core**: total-order broadcast, commutative deltas, offline rebase rules, OT vs CRDT trade-off, collaborative undo
- [`docs/api.md`](docs/api.md) — every REST endpoint and socket event
- [`docs/database.md`](docs/database.md) — schema, ownership split, snapshots & restore mechanics
