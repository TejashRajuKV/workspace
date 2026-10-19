# Next.js to React + Vite + Express migration plan

## Goal

Replace the Next.js application runtime with a conventional React + Vite frontend and Node.js + Express API while preserving the current product behavior and stored data. This is a staged migration, not a flag-day rewrite.

## Current architecture (verified from the repository)

- `src/app/page.js` is the single-page UI entry point. It renders the auth, dashboard, and workspace views from Zustand session state.
- UI components live under `src/components/workspace/`; state stores live under `src/state/`; shared canvas/OT protocol code lives under `src/shared/`.
- The frontend calls same-origin REST endpoints under `/api`.
- Next.js route handlers implement auth and workspace/file operations under `src/app/api/`.
- `src/lib/auth.js` uses `next/headers` cookies, and `src/lib/apiHelpers.js` uses `NextResponse`. These are framework dependencies that must be removed from shared business logic before Express can own the API.
- Prisma owns users, sessions, workspaces, membership, and documents. The collaboration service uses SQLite tables for canvas state and operation history. Both services share the configured SQLite database.
- `src/lib/socket.js` connects to the collaboration Socket.IO service through the configured transform port. The migration must preserve this protocol and endpoint.

## Compatibility rules

1. Do not reset, recreate, or silently migrate the production SQLite database during the frontend/runtime migration.
2. Keep Prisma models, table mappings, session token format, cookie name (`iw_session`), and role semantics stable.
3. Preserve existing JSON response shapes, status codes, and `/api` URLs. Avoid a simultaneous API redesign.
4. Keep the collaboration service and its protocol working while the REST server changes.
5. Keep the current Next.js launch path available until the Vite frontend and Express API pass parity checks.
6. Never put secrets or real database files in source control.

## Staged implementation

### Stage 1 — API compatibility layer

- Extract framework-neutral helpers for cookie parsing, session-token lookup, password verification, authorization, and JSON error payloads.
- Make request/response handling an Express adapter rather than importing `next/headers` or `NextResponse` in the core logic.
- Add API contract tests for register/login/session/logout, workspace CRUD, membership/roles, bootstrap, and file operations.
- Keep the existing Next.js routes as adapters until parity is established.

### Stage 2 — Express API

- Add a separate Express entry point and mount route modules matching the existing `/api` paths.
- Use an explicit JSON body-size limit and consistent error middleware.
- Apply cookie and security settings equivalent to the existing `httpOnly`, `sameSite=lax`, production-secure session cookie.
- Add a health/readiness endpoint that checks process health and database connectivity without exposing secrets.
- Preserve the existing Socket.IO collaboration service as a separate process during the API transition.

### Stage 3 — Vite frontend

- Add Vite config with the existing `@/* -> src/*` alias and React support.
- Use the current page component as the SPA entry point and preserve existing CSS/Tailwind processing.
- Configure development proxy rules for `/api` and the Socket.IO collaboration endpoint.
- Serve the built static assets from the production web server and keep deep links such as `/?w=<workspaceId>` working.

### Stage 4 — Verification and cutover

- Run the existing lint and test suites plus API parity tests.
- Test registration, login/logout, refresh/session restoration, create/join workspace, owner/editor/viewer permissions, file/folder CRUD and rename/move conflicts, document sync, canvas undo/restore, and two-client collaboration.
- Validate clean install, production build, health checks, and restart behavior against a disposable SQLite database first.
- Switch the default start command only after all checks pass. Retain a documented rollback path.

## Deployment considerations

The app has a persistent SQLite database and a separate collaboration process. A free deployment target must support persistent disk storage and long-running WebSocket connections. Static-only hosting is insufficient for the full application. Do not advertise a deployment as production-ready until persistence, WebSocket routing, backups, and restart recovery have been tested.

## Completion checklist

- [ ] Framework-neutral auth/session helpers
- [ ] Express API with endpoint parity
- [ ] Vite build using existing React components
- [ ] Same-origin API and WebSocket routing
- [ ] API contract and end-to-end tests
- [ ] Clean production build and deployment smoke test
- [ ] Documented backup/restore and rollback procedure
