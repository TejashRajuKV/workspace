import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApiServer } from "../server/index.js";

async function withServer(run) {
  const server = createApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("Node API health and unknown routes", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const missing = await fetch(`${base}/not-a-route`);
    assert.equal(missing.status, 404);
  });
});

test("unmigrated API routes explicitly return 501", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/workspaces/demo/versions`);
    assert.equal(response.status, 501);
    assert.match((await response.json()).error, /not been migrated/);
  });
});

test("workspace endpoints enforce authentication before reading workspace data", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/workspaces`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Not authenticated" });
  });
});

test("file mutations require an authenticated workspace member", async () => {
  await withServer(async (base) => {
    const create = await fetch(`${base}/api/workspaces/demo/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes.txt", content: "hello" }),
    });
    assert.equal(create.status, 401);
    assert.deepEqual(await create.json(), { error: "Not authenticated" });

    const remove = await fetch(`${base}/api/workspaces/demo/files/file-1`, { method: "DELETE" });
    assert.equal(remove.status, 401);
    assert.deepEqual(await remove.json(), { error: "Not authenticated" });
  });
});
