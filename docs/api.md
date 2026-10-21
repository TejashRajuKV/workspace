# API Reference

## REST (Node.js, cookie session)

All JSON routes answer `{...}` with `2xx`; errors are `{error}` with a 4xx/5xx
status. The httpOnly `iw_session` cookie carries identity.

### Identity

| method & path | role | description |
|---|---|---|
| `GET /api/health` | - | service liveness + collab-service reachability |
| `POST /api/auth` `{mode:"register"\|"login", username, password}` | - | register or login; sets `iw_session` |
| `GET /api/auth/session` | any | current user or `{user:null}` |
| `DELETE /api/auth/session` | any | logout |

### Workspaces

| method & path | role | description |
|---|---|---|
| `GET /api/workspaces` | auth | active workspaces I belong to |
| `GET /api/workspaces?archived=1` | auth | archived workspaces I belong to |
| `POST /api/workspaces` `{name, description?, templateId?}` | auth | create (optionally seeded from a template); creator becomes `owner` |
| `GET /api/workspaces/:id` | member | meta + members + my role |
| `PATCH /api/workspaces/:id` | owner | `{name?, description?, allowIdJoin?, archived?}` (archive = toggle `archivedAt`) |
| `DELETE /api/workspaces/:id` | owner | delete workspace + all rows |
| `POST /api/workspaces/:id/join` | auth | join by ID (idempotent, becomes `editor`; needs `allowIdJoin`) |
| `GET /api/workspaces/:id/bootstrap` | member | one-shot load: workspace, role, members, documents with content |
| `POST /api/workspaces/:id/transfer` `{userId}` | owner | transfer ownership (target becomes `owner`, caller `editor`) |

### Members, invites, share links

| method & path | role | description |
|---|---|---|
| `PATCH /api/workspaces/:id/members/:userId` `{role}` | owner | change role (`editor`\|`viewer`) |
| `DELETE /api/workspaces/:id/members/:userId` | owner/self | remove a member (owner cannot be removed) |
| `POST /api/workspaces/:id/members/bulk` `{usernames, role}` | owner | add by username list -> `{added, alreadyMember, missing, role}` (adds only; never changes existing roles) |
| `POST /api/workspaces/:id/invites` `{role?, expiresInHours?, maxUses?}` | owner | create invite -> `{invite}` (plaintext code returned once) |
| `GET /api/workspaces/:id/invites` | owner | active invites (no plaintext codes) |
| `DELETE /api/workspaces/:id/invites/:inviteId` | owner | revoke |
| `GET /api/invites/:code` | auth | preview `{workspace, role, expiresAt}` |
| `POST /api/invites/:code/accept` | auth | join via code |
| `POST /api/workspaces/:id/share-links` `{expiresInHours?}` | owner | public read-only link -> `{share:{...,url:"/?s=<token>"}}` (token returned once) |
| `GET /api/workspaces/:id/share-links` | owner | list links (`revoked` included) |
| `DELETE /api/workspaces/:id/share-links/:linkId` | owner | revoke |
| `GET /api/share/:token` | public | snapshot `{workspace:{id,name,description}, files:[{path,content}], folders, canvas:[{id,type,z,payload}], assets, readOnly:true}`; 404/410 when invalid/expired/revoked |
| `GET /api/share/:token/assets/:assetId` | public | stream one asset for the shared board |

### Files (virtual file system)

| method & path | role | description |
|---|---|---|
| `POST /api/workspaces/:id/files` `{path, isFolder?, content?}` | editor | create file/folder (parents auto-created) |
| `PATCH /api/workspaces/:id/files/:fileId` `{path}` | editor | rename / move (folder descendants follow) |
| `DELETE /api/workspaces/:id/files/:fileId` | editor | soft delete (+ descendants) into trash |
| `POST /api/workspaces/:id/replace` `{query, replacement, caseSensitive?, dryRun?, paths?}` | editor | search & replace across files |
| `GET /api/workspaces/:id/files/:fileId/versions?limit&before` | member | per-file history |
| `GET /api/workspaces/:id/files/:fileId/versions/:version` | member | one historical version |
| `POST /api/workspaces/:id/files/:fileId/restore` `{version}` | editor | restore file content |
| `GET /api/workspaces/:id/export.zip` | member | workspace ZIP (board + files) |
| `POST /api/workspaces/:id/import.zip?dryRun=1&policy=skip\|overwrite\|rename` | editor | import a raw ZIP body (`.iw/canvas.json` restores the board) |

### Board history

| method & path | role | description |
|---|---|---|
| `GET /api/workspaces/:id/versions?limit&before` | member | canvas operation history (newest first, with user attribution) |
| `POST /api/workspaces/:id/restore` `{version}` | editor | restore board to a version (delegates to the collab service) |

### Trash, templates, analytics

| method & path | role | description |
|---|---|---|
| `GET /api/workspaces/:id/trash` | member | `{documents:[{id,path,isFolder,deletedAt,user}], canvasTrash}` |
| `POST /api/workspaces/:id/trash/restore` `{documentId}` | editor | restore file/folder subtree |
| `DELETE /api/workspaces/:id/trash?documentId=` | editor | purge one item (subtree); without the query = empty trash |
| `GET /api/templates` | auth | my saved templates |
| `POST /api/templates` `{name, description?, workspaceId}` | owner | snapshot files + board into a template |
| `DELETE /api/templates/:templateId` | auth (owner of template) | delete template |
| `GET /api/workspaces/:id/analytics` | member | `{activity:[{date,count}], series:[{date,count}] (dense 30 days), topEditors:[{user,count}], totals}` |

### Assets (image uploads)

| method & path | role | description |
|---|---|---|
| `POST /api/workspaces/:id/assets` | editor | raw image body, `content-type` = mime, optional `x-filename`; max 8 MB -> `{asset}` |
| `GET /api/workspaces/:id/assets` | member | list |
| `GET /api/workspaces/:id/assets/:assetId` | member | stream (`content-type` from the row) |

Board payloads reference assets as `"/api/workspaces/<id>/assets/<assetId>"`;
`data:image/...` URLs are also accepted up to `MAX_IMAGE_BYTES`.

### GitHub (PAT only)

| method & path | role | description |
|---|---|---|
| `GET /api/workspaces/:id/github` | member | link status (never returns the token) |
| `PUT /api/workspaces/:id/github` `{token, owner, repo, branch?, createRepo?, private?}` | owner | connect; token is AES-256-GCM encrypted |
| `DELETE /api/workspaces/:id/github` | owner | disconnect |
| `POST /api/workspaces/:id/github/push` `{branch?, message?, prune?}` | owner | one commit via the Git Data API (unchanged blobs skipped; `prune` deletes remote files missing locally) |
| `GET /api/workspaces/:id/github/branches` | member | remote branches |
| `POST /api/workspaces/:id/github/preview` `{branch?, includeContent?}` | member | `{fileDiffs:[{path,remote,local}]}` without writing |
| `POST /api/workspaces/:id/github/pr` `{title, body?, head?, base?}` | owner | open a pull request -> `{pull:{number,html_url}}` |
| `POST /api/workspaces/:id/github/pull` `{branch?, mode?, policy?}` | owner | import remote files (`mode:"merge"\|"replace"`, `policy:"overwrite"\|"rename"`) |

### Notifications

| method & path | role | description |
|---|---|---|
| `GET /api/notifications?unread=1&limit=50` | auth | `{notifications, unread}` (newest first) |
| `POST /api/notifications/read` `{all:true}` or `{ids:[...]}` | auth | mark read |
| `DELETE /api/notifications/:notifId` | auth | dismiss |

### Automation (owner only)

| method & path | description |
|---|---|
| `GET /api/workspaces/:id/webhooks` | `{webhooks, events}` - supported event names |
| `POST /api/workspaces/:id/webhooks` `{url, events:[...]}` | create -> `{webhook, secret}` (secret shown once; stored hashed) |
| `PATCH /api/workspaces/:id/webhooks/:hookId` `{url?, events?, enabled?}` | update |
| `DELETE /api/workspaces/:id/webhooks/:hookId` | delete |
| `GET /api/workspaces/:id/webhooks/:hookId/deliveries?limit=25` | recent delivery attempts (status, error) |
| `GET /api/workspaces/:id/schedules` | scheduled exports |
| `POST /api/workspaces/:id/schedules` `{intervalHours}` | create (1-720 h, default 24) |
| `PATCH /api/workspaces/:id/schedules/:jobId` `{enabled?, intervalHours?}` | update |
| `DELETE /api/workspaces/:id/schedules/:jobId` | delete |
| `GET /api/workspaces/:id/rules` | `{rules, triggers, actions}` |
| `POST /api/workspaces/:id/rules` `{name, trigger, action, config?}` | create (`action`: `webhook`\|`notify`) |
| `PATCH /api/workspaces/:id/rules/:ruleId` | update |
| `DELETE /api/workspaces/:id/rules/:ruleId` | delete |

Roles: `owner` (created it) · `editor` (joined) · `viewer` (read-only; all
write APIs and socket mutations return 403).

## Socket.IO (collab service via `io('/?XTransformPort=3003')`)

Identity: the session cookie rides along automatically (or `auth: {token}`).
Unauthorized sockets are rejected at handshake.

### Connection / room

| event | payload -> ack | notes |
|---|---|---|
| `ws:join` | `{workspaceId}` -> `{version, objects, docs, role, peers, you}` | join the room; full board state + doc tree |
| `ws:leave` | - | leave room |
| `sync:request` | `{since}` -> `{ops[], objects[], version}` or `{full:true, objects[], version}` | catch up after a gap/offline; `objects` carries the canonical record of every touched object |
| `ws:restored` (broadcast) | `{toVersion, by, opsApplied}` | a version restore happened |

### Canvas

| event | payload -> ack | notes |
|---|---|---|
| `canvas:op` | `{ops:[{id,type,oid,p}]}` -> `{ok, version}` + `canvas:ack {results}` | batch of validated ops; per-op results include assigned versions |
| `canvas:op` (broadcast) | `{op, version, by}` | to every *other* client, strictly in version order |
| `canvas:ack` | `{results:[{id, ok, version, error?}]}` | sender-side; rejected ops trigger client re-sync |

Op types: `create {object:{id,type,z,payload}}` · `delete {}` ·
`move {dx,dy}` · `resize {x,y,w,h}` · `rotate {rot}` · `style {style}` ·
`text {text}` · `zorder {z}` · `group {groupId}` (`""` = ungroup) ·
`comment {action:"reply", entry:{id,body,at}}` ·
`comment {action:"resolve", resolved}` · `comment {action:"edit", text}`.

Comment authors are **assigned by the service** from the socket identity; the
service also emits `comment.created` to the web server for notifications.

`group` is an absolute assignment on one object; a group is a loose cluster of
objects sharing `payload.groupId` (selection expands to the whole cluster).

### Documents (OT)

| event | payload -> ack | notes |
|---|---|---|
| `doc:open` | `{documentId}` -> `{content, rev}` | authoritative content + revision |
| `doc:op` | `{documentId, op, rev}` -> `{rev}` | op components; `rev` = client's base revision; server transforms |
| `doc:op` (broadcast) | `{documentId, op, rev, by}` | transformed op, sequential revisions |
| `doc:sync` | `{documentId, since}` -> `{ops[], rev}` or `{reset:true, content, rev}` | gap recovery |

### Presence

| event | payload | notes |
|---|---|---|
| `presence:update` | `{cursor?, selection?, view?, editor?, status?, activity?, typing?}` | ≤20 Hz; `status` = `active`\|`idle`\|`away`, `activity` = free label (e.g. `editing main.ts`), `typing` = boolean |
| `presence:state` (broadcast) | `{users:{sid:{user,cursor,selection,view,editor,status,activity,typing}}}` | aggregated 15 Hz |
| `presence:joined` / presence left implicitly | `{user}` | avatar list updates |

### Execution

| event | payload -> ack | notes |
|---|---|---|
| `exec:start` | `{fileId, language?}` -> `{ok, runId}` | language inferred from extension |
| `exec:started` | `{runId, language, entryPath}` | run accepted |
| `exec:output` | `{runId, stream:"stdout"\|"stderr", chunk}` | streamed |
| `exec:input` | `{runId, text}` | stdin for the pipe-based REPL (buffered until the program reads) |
| `exec:cancel` | `{runId}` | SIGKILL the process tree |
| `exec:history` | limit -> `{runs:[{runId, fileId, language, exitCode, durationMs, at}]}` | recent runs of this workspace |
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
| `POST :3004/internal/notify` `{userId?, userIds?, workspaceId, type, title, body?, linkType?, linkId?, actorId?}` | deliver a notification to one or many users |
| `POST :3004/internal/broadcast` `{workspaceId, event, payload, except?}` | generic room broadcast |
| `POST :3004/internal/seed-canvas` `{workspaceId, objects}` | seed template/import content into the live room |
| `POST :3004/internal/health` | liveness |
| `POST :3005/internal/events` `{workspaceId, event, actorId?, payload?}` | collab -> web: fans out automation webhooks/rules and notifications |
