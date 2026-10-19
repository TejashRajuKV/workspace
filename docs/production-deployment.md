# Production deployment

This application is a full-stack service, not a static website. It requires a persistent filesystem for SQLite and two cooperating Node/Bun processes.

## Recommended launch shape

Deploy to a persistent Node host or a VM that supports long-running processes and WebSocket upgrades. A static frontend host is not sufficient. Keep the Next.js app and collaboration service on the same host initially so they can share one SQLite file and the internal endpoint can stay bound to loopback.

## Required environment

Set these on the host before starting services:

- `NODE_ENV=production`
- `DATABASE_URL=file:/absolute/path/to/persistent-data/custom.db`
- `DATABASE_PATH=/absolute/path/to/persistent-data/custom.db` (must point to the exact same file as DATABASE_URL)
- `INTERNAL_TOKEN=<random secret at least 32 characters long>`
- `COLLAB_SERVICE_URL=http://127.0.0.1:3004`
- `PORT=3000` for the Next.js app and `PORT=3003` for the collaboration process, configured separately per process
- `INTERNAL_PORT=3004` for the collaboration process

Generate a secret with `openssl rand -hex 32`. Do not commit secrets or database files.

## Build

Use the Bun version compatible with the lockfile and the Node version required by `node:sqlite` (Node 22+; Node 24 is preferred).

```bash
bun install --frozen-lockfile
bun run db:generate
mkdir -p db
DATABASE_URL=file:$PWD/db/custom.db bun run db:push
bun run build
```

Ensure `db/custom.db` is on persistent disk and writable by the runtime user. For clean production setup, use a persistent directory, not a temporary build directory. The web and collaboration processes must use the same database path.

## Start

Start the collaboration service and web server as separate long-running processes:

```bash
INTERNAL_TOKEN="$INTERNAL_TOKEN" DATABASE_PATH="$DATABASE_PATH" PORT=3003 INTERNAL_PORT=3004 node mini-services/collab-service/index.js
```

In a second process:

```bash
NODE_ENV=production INTERNAL_TOKEN="$INTERNAL_TOKEN" COLLAB_SERVICE_URL=http://127.0.0.1:3004 DATABASE_URL="file:$DATABASE_PATH" PORT=3000 bun run start:web
```

The exact command syntax for environment variables may differ on Windows or your hosting platform. Configure an equivalent persistent process supervisor so both services restart after a crash/reboot.

## Reverse proxy / networking

- Expose the web process (port 3000) to the public internet.
- Route only the Socket.IO query parameter `XTransformPort=3003` to the collaboration service and enable WebSocket upgrades. Never interpolate a client-supplied query parameter into the upstream host/port. The included `Caddyfile` pins this route to port 3003; adapt the listener/domain to your host.
- Do not expose port 3004. It is an internal loopback-only endpoint.
- Do not use a serverless/ephemeral filesystem for the SQLite database. This app currently uses one SQLite file shared by both processes.

## Post-deploy smoke test

1. Visit the site and register a test account.
2. Create a workspace, draw an object, refresh, and verify it persisted.
3. Open a second browser profile, register another account, join the workspace ID, and verify live canvas and editor updates in both directions.
4. Run a small JavaScript file and verify output and exit code.
5. Test logout/session expiry and verify anonymous WebSocket access is rejected.
6. Run `bun run check:deployment` before release.

## Important security note

The integrated code runner executes user-authored JavaScript/Python in child processes. The built-in protections (timeouts, output caps, file limits) are useful guardrails but are not a strong multi-tenant sandbox. Do not expose this service to untrusted public users without adding container/VM isolation and stronger OS-level limits.
