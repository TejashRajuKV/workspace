# API Reference

## REST (Next.js, cookie session)

| method & path | role | description |
|---|---|---|
| `POST /api/auth` `{mode:"register"\|"login", username, password}` | — | register or login; sets the httpOnly `iw_session` cookie |
| `GET /api/auth/session` | any | current user or `{user:null}` |
| `DELETE /api/auth/session` | any | logout |
| `GET /api/workspaces` | auth | workspaces I am a member of |
| `POST /api/workspaces` `{name, description?}` | auth | create; creator becomes `owner` |
| `GET /api/workspaces/:id` | member | meta + members + my role |
| `PATCH /api/workspaces/:id` | editor | rename / description |
| `DELETE /api/workspaces/:id` | owner | delete workspace |
| `POST /api/workspaces/:id/join` | auth | join by ID (idempotent, becomes `editor`) |
| `GET /api/workspaces/:id/bootstrap` | member | one-shot load: workspace, role, members, all documents (with content) |
| `POST /api/workspaces/:id/files` `{path, isFolder?, content?}` | editor | create file/folder (parents auto-created) |
| `PATCH /api/workspaces/:id/files/:fileId` `{path}` | editor | rename / move (folder descendants follow) |
| `DELETE /api/workspaces/:id/files/:fileId` | editor | soft delete (+ descendants) |
| `GET /api/workspaces/:id/versions?limit&before` | member | operation history (newest first, with user attribution) |
| `POST /api/workspaces/:id/restore` `{version}` | editor | restore board to a version (delegates to service) |

Roles: `owner` (created it) · `editor` (joined) · `viewer` (read-only; all
write APIs and socket mutations return 403).

## Socket.IO (collab service via `io('/?XTransformPort=3003')`)

Identity: the session cookie rides along automatically (or
`auth: {token}`). Unauthorized sockets are rejected at handshake.

### Connection / room

| event | payload → ack | notes |
|---|---|---|
| `ws:join` | `{workspaceId}` → `{version, objects, docs, role, peers, you}` | join the room; full board state + doc tree |
| `ws:leave` | — | leave room |
| `sync:request` | `{since}` → `{ops[], objects[], version}` or `{full:true, objects[], version}` | catch up after a gap/offline; `objects` carries the canonical record of every touched object for wholesale reconciliation |
| `ws:restored` (broadcast) | `{toVersion, by, opsApplied}` | a version restore happened |

### Canvas

| event | payload → ack | notes |
|---|---|---|
| `canvas:op` | `{ops:[{id,type,oid,p}]}` → `{ok, version}` + `canvas:ack {results}` | batch of validated ops; per-op results include assigned versions; rejected ops report `ok:false` |
| `canvas:op` (broadcast) | `{op, version, by}` | to every *other* client, strictly in version order |
| `canvas:ack` | `{results:[{id, ok, version, error?}]}` | sender-side; rejected ops trigger client re-sync |

Op types: `create {object:{id,type,z,payload}}` · `delete {}` ·
`move {dx,dy}` · `resize {x,y,w,h}` · `rotate {rot}` · `style {style}` ·
`text {text}` · `zorder {z}`.

### Documents (OT)

| event | payload → ack | notes |
|---|---|---|
| `doc:open` | `{documentId}` → `{content, rev}` | authoritative content + revision |
| `doc:op` | `{documentId, op, rev}` → `{rev}` | op components; `rev` = client's base revision; server transforms |
| `doc:op` (broadcast) | `{documentId, op, rev, by}` | transformed op, sequential revisions |
| `doc:sync` | `{documentId, since}` → `{ops[], rev}` or `{reset:true, content, rev}` | gap recovery |

### Presence

| event | payload | notes |
|---|---|---|
| `presence:update` | `{cursor?, selection?, view?, editor?}` | ≤20 Hz; `editor = {fileId, offset, anchor}` |
| `presence:state` (broadcast) | `{users:{sid:{user,cursor,selection,view,editor}}}` | aggregated 15 Hz |
| `presence:joined` / presence left implicitly | `{user}` | avatar list updates |

### Execution

| event | payload → ack | notes |
|---|---|---|
| `exec:start` | `{fileId, language?}` → `{ok, runId}` | language inferred from extension |
| `exec:started` | `{runId, language, entryPath}` | run accepted |
| `exec:output` | `{runId, stream:"stdout"\|"stderr", chunk}` | streamed |
| `exec:end` | `{runId, exitCode, durationMs, timedOut, error?}` | terminal state |

### Filesystem notifications

| event | payload | notes |
|---|---|---|
| `fs:changed` (broadcast) | `{kind}` | after REST file CRUD; clients re-fetch the tree |

## Internal HTTP (localhost only, `x-internal-token`)

| endpoint | description |
|---|---|
| `POST :3004/internal/fs-changed` `{workspaceId, kind}` | broadcast `fs:changed` + invalidate doc caches |
| `POST :3004/internal/restore` `{workspaceId, version, byUserId, byName}` | run restore pipeline |
| `POST :3004/internal/health` | liveness |
