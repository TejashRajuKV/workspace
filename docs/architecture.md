# Architecture

## Runtime topology

The sandbox exposes a single gateway port (Caddy, :81). Everything is
reachable through it:

| path | destination |
|---|---|
| any request with `?XTransformPort=3003` | collaboration service (Socket.IO) |
| everything else | web server (:3000) |

The web server (`server/index.js`, plain `node:http`) serves the static SPA
from `dist/client` (single route `/` — the gateway exposes one URL) and the
REST API under `/api/*`. The collaboration service runs as an independent
Node process (`mini-services/collab-service`, started automatically by the
platform's dev script) and exposes a second, **localhost-only** HTTP listener
(:3004) for server-to-server calls from the web server (restore, fs-changed
broadcasts, health).

## Process & data ownership

Two Node processes share one SQLite database in WAL mode:

| owner | runtime | tables | why |
|---|---|---|---|
| web server (`server/`) | Node (Prisma) | users, sessions, workspaces, workspace_members, workspace_invites, documents (CRUD), document_snapshots, github_links, assets, workspace_templates, share_links, notifications, webhooks, webhook_deliveries, scheduled_jobs, automation_rules | CRUD + auth through the Prisma schema |
| collaboration service | Node 22+ | workspace_state, canvas_objects, operations, document_operations, snapshots | hot operation path; synchronous raw SQL via `node:sqlite`, zero native deps |

Both processes are plain Node; the split is about **access style**, not
runtime. The service drives its write path with hand-written SQL so nothing
sits between the sequencer and the disk, while everything else goes through
Prisma. WAL allows concurrent readers plus a single writer across processes;
write transactions use `BEGIN IMMEDIATE` with busy-timeout retries.

Cross-process notifications go over internal HTTP in both directions:

- **web → service** (`:3004`): `fs-changed`, `restore`, `notify`, `broadcast`,
  `seed-canvas`, `health`.
- **service → web** (`:3005 /internal/events`): `comment.created`,
  `github.*`, `board.restored` — the web server fans these out to
  notifications and automation webhooks/rules.

## Comments, groups and layers

- A comment is a **canvas object** (`type:"comment"`) with
  `data:{text,resolved,thread:[{id,authorId,authorName,body,at}]}`, so pins
  replicate through the ordinary op log and survive restore.
- `OP.COMMENT` carries `action: reply | resolve | edit`. The client sends the
  entry id and body only; the **service stamps `authorId/authorName`** from the
  socket identity (prevents spoofing) and re-broadcasts the enriched op, so
  every client and the append-only log agree on authorship.
- Groups are not container objects: `OP.GROUP {groupId}` is an absolute
  assignment of `payload.groupId` on one object, and the client expands the
  selection to the whole cluster (`withGroupExpand`). Ungroup is `groupId:""`.
- The layers panel is a column of the workspace row (not a canvas overlay) and
  reads z-order from the board store; every action emits a normal op
  (`zorder`, `delete`, group).

## Frontend architecture

```
App.jsx (SPA view state: landing → auth → dashboard → workspace | public share)
│
├── state/session.js      zustand: view, user, bootstrap
├── state/board.js        zustand + boardRefs (non-reactive):
│     objects Map · camera · selection · pending ops · history
│     presenceByUser · comments panel state
│     socket wiring: canvas:op/ack, sync:request/response, presence
│     offline queue + reconcile() (see synchronization.md)
├── state/code.js         per-doc OT pipeline (outstanding/buffer),
│     transformed-inverse undo, resync handling, seedDocState()
├── state/notifications.js unread list, browser Notification API
├── lib/shortcuts.js      remappable tool keys (localStorage iw.shortcuts.v1)
├── lib/markdown.js       safe mini-renderer for the .md preview pane
├── lib/monacoTheme.js    shared IW dark theme (editor + diff)
│
├── canvas-engine/
│   ├── camera.js      world↔screen, anchored zoom (0.02×–8×)
│   ├── quadtree.js    region quadtree, O(1) removal via node map
│   ├── geometry.js    bounds, rotation, per-type hit tests, RDP simplify
│   ├── renderer.js    dirty-flag rAF painter: grid, culled objects,
│   │                  selection/handles, remote selections, cursors,
│   │                  comment pins, frames
│   ├── tools.js       pointer/keyboard → ops; group expansion; tool keys
│   └── history.js     inverse-op builders
│
└── workspace views    TopBar (+ More menu) · Toolbar · CanvasBoard ·
                       FileExplorer · CodePanel (Monaco) · Terminal ·
                       HistoryPanel · CommentsPanel · LayersPanel ·
                       ShortcutsDialog · ShareDialog · GithubDialog ·
                       AutomationDialog · AnalyticsDialog · TemplatesDialog ·
                       TrashDialog · NotificationsPanel · PublicShareView
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

The in-app terminal is a **pipe-based REPL** on top of the same runs: stdin is
written to the child's pipe (`exec:input`, buffered until the program reads),
`exec:cancel` kills the process tree, and `exec:history` lists recent runs.
No `node-pty`/native dependency is involved, so a program that requires a real
TTY will not behave like one — an accepted trade-off.

## Public share links

`POST /api/workspaces/:id/share-links` mints a 160-bit random token, stores
only its SHA-256 hash and returns `/?s=<token>` once. `App.jsx` detects `s` in
the query string and renders `PublicShareView` instead of the session flow: it
calls `GET /api/share/:token`, fits the camera to the returned canvas snapshot,
renders with the same renderer, substitutes asset URLs with the public
`/api/share/:token/assets/:id` stream, and shows files read-only in Monaco.
Nothing is writable and no socket is opened — the snapshot is a point-in-time
view (owner revokes by flipping `revoked`).

## Notifications and automation

- The collab service emits domain events to the web server
  (`comment.created`, `github.push`, `github.pull`, `board.restored`). The web
  server turns them into `notifications` rows (one per recipient, including
  `@mention` targets) and, when configured, automation work.
- Browser notifications use the Notification API from the client; there is no
  push service (works while a tab is open, matching the no-external-services
  constraint).
- Webhooks are signed with an HMAC secret (shown once, stored hashed), retried
  with backoff through `webhook_deliveries.next_attempt_at`, and every attempt
  is visible in the dialog.
- Scheduled jobs (`scheduled_jobs`) are polled by a ticker in the web server
  and enqueue export deliveries; rules (`automation_rules`) map a trigger to a
  `webhook` or `notify` action.
- All automation routes are owner-only.

## Offline / PWA

`public/manifest.webmanifest` + a hand-written service worker
(`public/sw.js`) cache the app shell and serve a fallback page when offline.
Board edits made while disconnected stay in the existing offline queue and are
rebased on reconnect (`reconcile()`), so offline support did not need a second
sync path.

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
- **Bearer secrets are hashed at rest**: invite codes, share-link tokens and
  webhook signing secrets are stored as SHA-256 hashes and shown once. GitHub
  PATs must remain usable, so they are AES-256-GCM encrypted with
  `GITHUB_TOKEN_KEY` (a missing/changed key makes the link unreadable rather
  than leaking it).
- **Uploads** are image-only, capped at 8 MB, served with the stored mime type
  and `private, max-age=86400`; public share assets are reachable only through
  an unrevoked, unexpired token.
- **Public share snapshots** cap total bytes and expose no session, member or
  invite data — just `{workspace:{id,name,description}, files, folders, canvas,
  assets, readOnly:true}`.
