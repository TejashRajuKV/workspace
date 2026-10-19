# Node.js API migration status

The Node runtime is being introduced alongside the existing Next.js app so the current app remains deployable during migration.

## Run the API server

```sh
npm run start:node
# or during development
npm run dev:node
```

It listens on `PORT` (default `3001`) and binds to `HOST` (default `0.0.0.0`). Set `DATABASE_URL` to the same persistent SQLite database used by the app, and run the existing Prisma generation/database setup first.

## Migrated endpoints

- `GET /healthz` — liveness check.
- `POST /api/auth` — login or register with JSON `{ "mode": "login" | "register", "username": "...", "password": "..." }`.
- `GET /api/auth/session` — current session user or `null`.
- `DELETE /api/auth/session` — destroy the current session and clear its cookie.
- `GET /api/workspaces` — list workspaces for the authenticated user.
- `POST /api/workspaces` — create a workspace and owner membership.
- `POST /api/workspaces/:id/join` — join a workspace by ID (existing membership is idempotent).
- `GET /api/workspaces/:id/bootstrap` — return workspace metadata, members, role, and active document tree.
- `POST /api/workspaces/:id/files` — create or restore a file/folder path, creating missing parent folders.
- `PATCH /api/workspaces/:id/files/:fileId` — rename/move a file or folder, with descendant-path conflict checks.
- `DELETE /api/workspaces/:id/files/:fileId` — soft-delete a file or a folder and its descendants.
- `GET /api/workspaces/:id/versions` — return recent operation history with user attribution and pagination.
- `POST /api/workspaces/:id/restore` — ask the collaboration service to restore a workspace to an earlier version; requires editor/owner access.

The endpoints reuse existing Prisma models, password hashing, session token format, and the `iw_session` cookie. They are designed to remain compatible with records and sessions created by the current Next.js server.

## Not yet migrated

The Vite frontend, Socket.IO/collaboration integration in the new server process, and production deployment cutover are still pending. Other `/api/*` endpoints intentionally return HTTP 501 rather than pretending to work. Keep the current Next.js production start command until the remaining endpoints and collaboration flow have been migrated and tested end to end.
