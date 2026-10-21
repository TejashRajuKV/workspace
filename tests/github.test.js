import test from "node:test";
import assert from "node:assert/strict";
import { gitBlobSha, isValidBranch, isValidRepoPart } from "../server/lib/github.js";
import { openToken, sealToken } from "../server/lib/secrets.js";

test("git blob sha matches git hash-object", () => {
  assert.equal(gitBlobSha("hello"), "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
  assert.equal(gitBlobSha("test content"), "08cf6101416f0ce0dda3c80e627f333854c4085c");
});

test("branch names are validated", () => {
  for (const ok of ["main", "dev", "feature/github-sync", "release/v1.2.3"]) {
    assert.equal(isValidBranch(ok), true, ok);
  }
  for (const bad of ["", "bad branch", "../x", "x..y", "/x", "x/", "x.lock", "a:b", "a\\b"]) {
    assert.equal(isValidBranch(bad), false, bad);
  }
});

test("repository owner and name are validated", () => {
  assert.equal(isValidRepoPart("octocat"), true);
  assert.equal(isValidRepoPart("my.repo-1_2"), true);
  assert.equal(isValidRepoPart("bad/name"), false);
  assert.equal(isValidRepoPart(".."), false);
  assert.equal(isValidRepoPart(""), false);
});

test("github tokens round-trip through encryption and reject tampering", () => {
  const sealed = sealToken("github_pat_example_token");
  assert.equal(openToken(sealed), "github_pat_example_token");
  const tampered = { ...sealed, tokenTag: Buffer.alloc(16).toString("base64") };
  assert.equal(openToken(tampered), null);
});
