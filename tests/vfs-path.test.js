// Regression: virtual-file-system path validation must accept folder paths.
//
// Found in inspection pass 2: folders are stored with a trailing slash
// ("src/") and the UI sends exactly that, but validateFilePath split the raw
// string on "/" and rejected the resulting empty segment — so EVERY "New
// folder" request returned 400 "invalid path segment" and the button silently
// failed (only a transient toast). Folders created indirectly (auto-created
// parents) bypassed the validator, masking the bug.

import test from "node:test";
import assert from "node:assert/strict";
import { validateFilePath } from "../src/shared/protocol.js";

test("folder paths with a trailing slash are valid", () => {
  assert.equal(validateFilePath("src/"), null);
  assert.equal(validateFilePath("a/b/c/"), null);
  assert.equal(validateFilePath("docs/notes/"), null);
});

test("plain file paths still validate", () => {
  assert.equal(validateFilePath("main.js"), null);
  assert.equal(validateFilePath("src/main.js"), null);
});

test("invalid paths are still rejected", () => {
  assert.ok(validateFilePath(""), "empty rejected");
  assert.ok(validateFilePath("/"), "bare slash rejected");
  assert.ok(validateFilePath("src//main.js"), "empty inner segment rejected");
  assert.ok(validateFilePath("src/../etc"), "dotdot rejected");
  assert.ok(validateFilePath("./x"), "dot segment rejected");
  assert.ok(validateFilePath("a\\b"), "backslash rejected");
  assert.ok(validateFilePath("a/b\n"), "control chars rejected");
});
