# Database Design

Single SQLite file (`db/custom.db`), **WAL mode**, shared by two Node
processes:

- **web server / Prisma** — schema owner (`prisma/schema.prisma`), handles
  identity, workspace metadata and the virtual file system.
- **Collaboration service / `node:sqlite`** — raw SQL for the hot path; owns
  the materialized canvas state, both operation logs and snapshots.

WAL gives concurrent readers with a single writer across processes; the
service wraps each operation in `BEGIN IMMEDIATE … COMMIT` with busy-retry,
and all connections set `busy_timeout=5000`.

## Tables

### Identity & metadata (written by the web server)

```sql
users              (id, username UNIQUE, password_hash, color, created_at)
sessions           (id = 64-hex token PK, user_id, expires_at, created_at)
workspaces         (id, name, description, owner_id, allow_id_join,
                    archived_at, created_at, updated_at)
workspace_members  (id, workspace_id, user_id, role, joined_at,
                    UNIQUE(workspace_id, user_id))   -- role: owner|editor|viewer
workspace_invites  (id, workspace_id, code UNIQUE /* hashed */, role,
                    created_by, expires_at, max_uses, uses, revoked, created_at)
documents          (id, workspace_id, path, is_folder, content,
                    doc_version, created_by, created_at, updated_at, deleted,
                    deleted_at, UNIQUE(workspace_id, path))
document_snapshots (id AUTOINC, document_id, workspace_id, version, content,
                    created_at, UNIQUE(document_id, version))
github_links       (id, workspace_id UNIQUE, owner, repo, branch,
                    token_cipher, token_iv, token_tag, last_commit_sha,
                    last_pushed_at, created_at, updated_at)
assets             (id, workspace_id, filename, mime, bytes, path,
                    created_by, created_at)
workspace_templates(id, name, description, created_by, payload JSON, created_at)
share_links        (id, workspace_id, token_hash UNIQUE, role, created_by,
                    expires_at, revoked, created_at)
notifications      (id, user_id, workspace_id, type, title, body, link_type,
                    link_id, actor_id, read_at, created_at)
webhooks           (id, workspace_id, url, secret /* hashed */, events,
                    enabled, created_by, created_at)
webhook_deliveries (id AUTOINC, webhook_id, workspace_id, event, payload,
                    status, attempts, next_attempt_at, last_status, last_error,
                    created_at, delivered_at)
scheduled_jobs     (id, workspace_id, kind, interval_ms, enabled, last_run_at,
                    next_run_at, last_error, created_by, created_at)
automation_rules   (id, workspace_id, name, trigger, action, config JSON,
                    enabled, created_by, created_at)
```

`documents` is the virtual file system: folders end with `/`, `content` holds
file text, `deleted` is a tombstone. `doc_version` is owned by the
collaboration service (incremented per OT operation).

### Realtime core (written by the collab service)

```sql
canvas_objects     (id PK, workspace_id, type, payload JSON,
                    z_index, created_by, created_at, updated_at,
                    updated_version, deleted)
operations         (id AUTOINC, workspace_id, user_id, type, object_id,
                    payload JSON, version, client_id, created_at,
                    UNIQUE(workspace_id, version))
workspace_state    (workspace_id PK, version, snapshot_version)
document_operations(id AUTOINC, workspace_id, document_id, user_id,
                    op JSON, base_rev, version, created_at)
snapshots          (id AUTOINC, workspace_id, version, state JSON, created_at)
```

- `canvas_objects` — **materialized current state** so opening a workspace is
  one indexed read, never a replay. `payload` is the full object
  (`{x,y,w,h,rot,style,data}`), validated on every operation.
- `operations` — the **append-only canvas log** (event sourcing).
  `version` is the per-workspace sequence number assigned by the sequencer;
  `client_id` is the submitter's op id, enabling idempotent resubmission
  after reconnect. Replays build state@version for restore.
- `workspace_state` — service-owned per-workspace counters (canvas version,
  last snapshot version).
- `document_operations` — the **per-document OT log**: the *transformed* op
  is stored with `base_rev` and the assigned `version`; late submissions are
  transformed against this log. Pruned logically: clients older than ~400
  revisions receive a full content reset.
- `snapshots` — full-state snapshot every 100 canvas versions (last 20 kept),
  used by restore: `state@V = snapshot(≤V) + replay(V..snapshot..V_target)`.

## Design decisions

- **Log + materialized state** instead of log-only: workspaces open
  instantly; the log exists for correctness (restore, audit, sync) rather
  than as the only source of current state.
- **BigInt timestamps**: epoch-ms values overflow SQLite/Prisma `Int`
  (32-bit); all `created_at`/`updated_at` columns are 64-bit. JSON
  boundaries convert back to `Number`.
- **Soft deletes** (`deleted`) for objects and files keep the operation log
  meaningful (a delete is itself an operation) and make restore trivial.
- **Per-workspace versioning** (`UNIQUE(workspace_id, version)`) keeps
  sequence numbers small and gap detection cheap; the global autoincrement
  `id` remains the physical row id.
- **Cross-process safety**: no shared prepared statements, short write
  transactions, WAL, busy retries. The service is the only writer for
  realtime tables; Prisma never writes them (it only reads `canvas_objects`
  state via the service, and `documents` content is written by both sides on
  disjoint concerns: CRUD vs content).
- **Trash is a timestamp, not a table**: `documents.deleted = 1` +
  `deleted_at` (0 for rows soft-deleted before the column existed; the UI
  renders those as "—"). Restore flips the flag for the whole path subtree;
  purge deletes the rows.
- **Only hashes on disk for bearer secrets**: `workspace_invites.code`,
  `share_links.token_hash` and `webhooks.secret` store SHA-256 hashes
  (plaintext is shown once at creation). GitHub PATs must stay usable, so they
  are stored as AES-256-GCM ciphertext (`token_cipher/iv/tag`, key from
  `GITHUB_TOKEN_KEY`) instead.
- **Templates are snapshots, not references**: `workspace_templates.payload`
  freezes `{files:[{path,isFolder,content}], canvas:[{type,z,payload}]}` so a
  template keeps working after the source workspace changes or is deleted.
- **Assets live on disk, rows in SQLite**: `assets.path` points under
  `db/uploads/<workspaceId>/`; the board stores only the stable
  `/api/workspaces/:id/assets/:assetId` URL. Deleting a workspace removes both.
- **Notifications are per-user rows** (`user_id`, `read_at`) with an index on
  `(user_id, read_at, created_at)`; fan-out happens in the web server, the
  realtime service only tells it *what* happened.
- **Automation state is derived from deliveries**: a webhook's health is the
  counts of `webhook_deliveries` by status; `scheduled_jobs.next_run_at` lets
  the ticker pick due jobs with one indexed query.
