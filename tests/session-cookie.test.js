import test from "node:test";
import assert from "node:assert/strict";
import { getCookieValue } from "../src/lib/sessionCookie.js";

test("reads a named cookie without depending on header ordering", () => {
  assert.equal(getCookieValue("theme=dark; iw_session=abc123; other=value", "iw_session"), "abc123");
});
test("decodes cookie values and preserves embedded equals signs", () => {
  assert.equal(getCookieValue("iw_session=token%3Dpart%3Dtwo", "iw_session"), "token=part=two");
});
test("does not match cookie names by prefix", () => {
  assert.equal(getCookieValue("iw_session_old=bad; iw_session=good", "iw_session"), "good");
});
test("returns null for missing, empty, or malformed inputs", () => {
  assert.equal(getCookieValue(undefined, "iw_session"), null);
  assert.equal(getCookieValue("theme=dark", "iw_session"), null);
  assert.equal(getCookieValue("iw_session", "iw_session"), null);
  assert.equal(getCookieValue("iw_session=%E0%A4%A", "iw_session"), "%E0%A4%A");
});
