# Architecture

## Runtime topology

The sandbox exposes a single gateway port (Caddy, :81). Everything is
reachable through it:

| path | destination |
|---|---|
| any request with `?XTransformPort=3003` | collaboration service (Socket.IO) |
| everything else | Next.js dev server (:3000) |

Next.js serves the SPA (single route `/` — the gateway exposes one URL) and
the REST API under `/api/*`. The collaboration service runs as an independent
Node process (`mini-services/collab-service`, started automatically by the
platform's dev script) and exposes a second, **localhost-only** HTTP listener
(:3004) for server-to-server calls from Next.js (restore, fs-changed
broadcasts, health).

## Process & data ownership

Two runtimes share one SQLite database in WAL mode:

| owner | runtime | tables | why |
|---|---|---|---|
| Next.js API routes | Bun (via `bun run dev`) | users, sessions, workspaces, workspace_members, documents (CRUD) | CRUD + auth; Prisma is reliable under Bun |
| collaboration service | Node 22+ | workspace_state, canvas_objects, operations, document_operations, snapshots | hot operation path; synchronous raw SQL via `node:sqlite`, zero native deps |

`better-sqlite3` crashes under Bun's N-API (tested) and `node:sqlite` is
absent in Bun — hence the split. WAL allows concurrent readers plus a single
writer across processes; write transactions use `BEGIN IMMEDIATE` with
busy-timeout retries.

Cross-process notifications (file CRUD via REST must reach live clients) go
over an internal HTTP call: Next → `POST :3004/internal/fs-changed` → service
broadcasts `fs:changed` to the room and invalidates OT caches.

## Frontend architecture

```
page.js (SPA view state: auth → dashboard → workspace)
│
├── state/session.js   zustand: view, user, bootstrap
├── state/board.js     zustand + boardRefs (non-reactive):
│     objects Map · camera · selection · pending ops · history
│     socket wiring: canvas:op/ack, sync:request/response, presence
│     offline queue + reconcile() (see synchronization.md)
├── state/code.js      per-doc OT pipeline (outstanding/buffer),
│     transformed-inverse undo, resync handling
│
├── canvas-engine/
│   ├── camera.js      world↔screen, anchored zoom (0.02×–8×)
│   ├── quadtree.js    region quadtree, O(1) removal via node map
│   ├── geometry.js    bounds, rotation, per-type hit tests, RDP simplify
│   ├── renderer.js    dirty-flag rAF painter: grid, culled objects,
│   │                  selection/handles, remote selections, cursors
│   ├── tools.js       pointer/keyboard → ops; drags mutate payloads
│   │                  directly (60 fps) + throttled op emission (20 Hz)
│   └── history.js     inverse-op builders
│
└── workspace views    TopBar · Toolbar · CanvasBoard · FileExplorer ·
                       CodePanel (Monaco, vendored in /public/monaco) ·
                       Terminal · HistoryPanel
```

Performance model:

- objects live in a `Map`; React re-renders only UI chrome (selection,
  tool, history tick, connection state) — never per-frame data;
- the quadtree syncs incrementally from a `changedIds` set each frame
  (full rebuild only on bootstrap/full refresh);
- rendering is culled through the quadtree: a 100k-object board draws the
  few hundred visible ones;
- presence streams never touch React state.

## Code execution without Docker

Threat model: a **local/trusted-user development feature**, not a public
sandbox. The manager (`execution.js`):

1. validates language against an allowlist (`.js` → `node`, `.py` → `python3`);
2. materializes the workspace's virtual files into a fresh `mkdtemp`
   directory (paths validated, ≤200 files, ≤2 MB total);
3. spawns `node <entry>` / `python3 <entry>` with **no shell**, `cwd` = temp
   dir, minimal env (`PATH`, `HOME=tmp`, `LANG`);
4. enforces an 8 s SIGKILL timeout and a 128 KB combined output cap (then
   kills the process);
5. limits concurrency: 1 run per user, 4 globally; rejects beyond that;
6. streams `exec:output` chunks and ends with `exec:end {exitCode,
   durationMs, timedOut}`; the temp dir is always removed.

For a public multi-user deployment this would need real isolation (containers/micro-VMs)
— documented as out of scope, matching the project's constraint.

## Security model

- **Identity** derives only from the session cookie (httpOnly, scrypt-hashed
  passwords, 30-day sessions). The socket handshake reuses the same cookie;
  clients never declare a userId.
- **Authorization** on every op: `ws:join` verifies membership; every canvas/doc/exec
  event re-checks the role (`viewer` is read-only) — nothing is trusted from
  the client, including userId, workspaceId and object payloads.
- **Validation** (`src/shared/protocol.js`): strict op/type checks, payload
  size caps (text 20 KB, images 600 KB, payload 700 KB), coordinate bounds,
  path traversal prevention, style sanitization.
- **Rate limiting**: token buckets per socket (canvas ops, doc ops, presence).
- **Internal endpoints** are bound to 127.0.0.1 and require a shared token.
