import test from "node:test";
import assert from "node:assert/strict";
import { clearCookie, jsonResult, serializeCookie } from "../src/lib/httpResponse.js";

test("jsonResult keeps a consistent JSON response contract", () => {
  assert.deepEqual(jsonResult({ error: "Not authenticated" }, 401), {
    status: 401,
    body: { error: "Not authenticated" },
    headers: { "content-type": "application/json; charset=utf-8" },
  });
});

test("serializeCookie encodes values and preserves session security options", () => {
  assert.equal(
    serializeCookie("iw_session", "a b", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 3600 }),
    "iw_session=a%20b; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax",
  );
});

test("clearCookie expires a cookie immediately", () => {
  assert.equal(clearCookie("iw_session", { path: "/", httpOnly: true }), "iw_session=; Max-Age=0; Path=/; HttpOnly");
});

test("serializeCookie rejects invalid cookie names and SameSite values", () => {
  assert.throws(() => serializeCookie("bad name", "x"), /Invalid cookie name/);
  assert.throws(() => serializeCookie("session", "x", { sameSite: "sometimes" }), /Invalid cookie sameSite/);
});
