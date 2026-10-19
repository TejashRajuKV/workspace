# Real-Time Collaborative Infinite Workspace

A full-stack collaborative workspace with an infinite whiteboard, live code editor, shared file tree, real-time presence, operation history, and a controlled JavaScript/Python runner.

## Start locally

Prerequisites: Bun, Node.js 22+ (Node 24 recommended for the collaboration service's `node:sqlite`), and Python 3 if you want to run Python files.

```bash
bun install
bun run db:generate
DATABASE_URL=file:$PWD/db/custom.db bun run db:push
```

Run the collaboration process in one terminal:

```bash
cd mini-services/collab-service
bun install
DATABASE_URL=file:$PWD/../../db/custom.db DATABASE_PATH=$PWD/../../db/custom.db node index.js
```

Run the web app from the repository root in another terminal:

```bash
DATABASE_URL=file:$PWD/db/custom.db bun run dev
```

Open http://localhost:3000. In a reverse-proxy setup, route the Socket.IO requests containing `XTransformPort=3003` to port 3003, and keep port 3004 internal.

## Tests and checks

```bash
bun run lint
bun run check:tests
bun run build
```

The `tests/` folder contains unit/regression tests for OT, canvas operations, synchronization, restored objects, and virtual file paths. `scripts/stress.js` can run a live multi-client stress test when both services and the gateway are running.

## Production deployment

This is **not a static site**. Production requires two long-running processes and a persistent writable disk because the current application uses a single SQLite file shared by the web and collaboration services. Follow [the production deployment guide](docs/production-deployment.md) for environment variables, process startup, networking, and a post-deploy smoke-test checklist.

Set a unique `INTERNAL_TOKEN` of at least 32 random characters in production. Configure `DATABASE_URL` and `DATABASE_PATH` to reference the same persistent SQLite file. Never commit secrets or database files.

## Security limitations

The workspace runner can execute user-authored JavaScript and Python. It has runtime limits and basic isolation, but it is not a hardened multi-tenant sandbox. Do not offer public execution to untrusted users without OS/container isolation and resource limits.
