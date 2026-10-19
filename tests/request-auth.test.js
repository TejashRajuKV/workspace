import test from "node:test";
import assert from "node:assert/strict";
import { authenticateRequest, authorizeWorkspaceRequest } from "../src/lib/requestAuth.js";

test("request authentication rejects requests without a session cookie", async () => {
  const result = await authenticateRequest({ headers: { cookie: "theme=dark" } });
  assert.deepEqual(result, { ok: false, status: 401, error: "Not authenticated" });
});

test("request authentication accepts Fetch-style headers", async () => {
  const result = await authenticateRequest({ headers: new Headers() });
  assert.deepEqual(result, { ok: false, status: 401, error: "Not authenticated" });
});

test("workspace authorization stops before membership lookup when unauthenticated", async () => {
  const result = await authorizeWorkspaceRequest({ headers: { cookie: "" } }, "workspace-id", { edit: true });
  assert.deepEqual(result, { ok: false, status: 401, error: "Not authenticated" });
});
