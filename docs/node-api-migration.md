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
- `POST /api/auth` — login or register using JSON `{ "mode": "login" | "register", "username": "...", "password": "..." }`.
- `GET /api/auth/session` — returns the current session user or `null`.
- `DELETE /api/auth/session` — destroys the current session and clears its cookie.

The auth endpoints reuse the existing Prisma database, password hashing, session token format, and `iw_session` cookie, so they are designed to remain compatible with sessions created by the current Next.js server.

Other `/api/*` endpoints deliberately return HTTP 501 until migrated. Do not switch the production frontend to this API server until the workspace endpoints, Socket.IO collaboration path, static frontend serving, and deployment checks have also been migrated and tested.
