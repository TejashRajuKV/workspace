// ============================================================
// Code execution without Docker — controlled child processes.
//
// Threat model (documented in docs/architecture.md): this is a LOCAL,
// trusted-user development feature, not a public sandbox. Protections:
//   - fixed language allowlist (JavaScript → node, Python → python3)
//   - files materialized into a fresh temp dir; paths validated
//   - timeout (SIGKILL), combined output cap, 1 run per user, global cap
//   - minimal environment, no shell, no privileged operations
// ============================================================

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./db.js";
import { validateFilePath } from "../../src/shared/protocol.js";

const EXEC_TIMEOUT_MS = 8000;
const MAX_OUTPUT = 128 * 1024;
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

const runningPerUser = new Map(); // userId → count
let runningTotal = 0;
const MAX_GLOBAL = 4;

export function startExecution(io, socket, room, { fileId, language }) {
  const userId = socket.data.userId;

  if ((runningPerUser.get(userId) || 0) >= 1)
    return { error: "You already have a program running" };
  if (runningTotal >= MAX_GLOBAL)
    return { error: "Server is busy — try again in a moment" };

  // load file + workspace files
  const entry = db
    .prepare("SELECT id, path, is_folder, deleted FROM documents WHERE id = ? AND workspace_id = ?")
    .get(fileId, room);
  if (!entry || entry.is_folder || entry.deleted)
    return { error: "Entry file not found" };

  const ext = path.extname(entry.path).toLowerCase();
  const lang =
    language || (ext === ".py" ? "python" : ext === ".js" || ext === ".mjs" ? "javascript" : null);
  if (lang !== "javascript" && lang !== "python")
    return { error: "Unsupported language — use .js or .py" };
  if (lang === "javascript" && ![".js", ".mjs"].includes(ext))
    return { error: "JavaScript entry must be a .js file" };
  if (lang === "python" && ext !== ".py")
    return { error: "Python entry must be a .py file" };

  const rows = db
    .prepare("SELECT path, content, is_folder FROM documents WHERE workspace_id = ? AND deleted = 0")
    .all(room);
  const files = rows.filter((r) => !r.is_folder);
  if (files.length > MAX_FILES) return { error: "Too many files to materialize" };
  let total = 0;
  for (const f of files) {
    if (validateFilePath(f.path)) return { error: `Invalid file path in workspace: ${f.path}` };
    total += Buffer.byteLength(f.content, "utf8");
  }
  if (total > MAX_TOTAL_BYTES) return { error: "Workspace too large to execute" };

  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iw-exec-"));
  } catch {
    return { error: "Could not create temp directory" };
  }

  try {
    for (const f of files) {
      const dest = path.join(tmpDir, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.content, "utf8");
    }
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { error: "Failed to materialize workspace: " + err.message };
  }

  const entryAbs = path.join(tmpDir, entry.path);
  const cmd = lang === "javascript" ? process.execPath || "node" : "python3";
  const args = [entryAbs];

  let child;
  try {
    child = spawn(cmd, args, {
      cwd: tmpDir,
      env: {
        PATH: process.env.PATH,
        HOME: tmpDir,
        LANG: "C.UTF-8",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { error: "Failed to spawn: " + err.message };
  }

  runningTotal++;
  runningPerUser.set(userId, (runningPerUser.get(userId) || 0) + 1);
  const runId = "run_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const startedAt = Date.now();
  let outputBytes = 0;
  let killed = false;
  let finished = false;

  const runInfo = { runId, language: lang, entryPath: entry.path };
  socket.emit("exec:started", runInfo);

  const timer = setTimeout(() => {
    killed = true;
    try {
      child.kill("SIGKILL");
    } catch {}
  }, EXEC_TIMEOUT_MS);

  const cleanup = () => {
    runningTotal--;
    runningPerUser.set(userId, Math.max(0, (runningPerUser.get(userId) || 1) - 1));
    clearTimeout(timer);
    setTimeout(() => fs.rmSync(tmpDir, { recursive: true, force: true }), 200);
  };

  const onChunk = (streamName) => (chunk) => {
    if (finished) return;
    const buf = Buffer.from(chunk);
    if (outputBytes + buf.length > MAX_OUTPUT) {
      const notice = "\n…output limit reached, process terminated…\n";
      socket.emit("exec:output", { runId, stream: streamName, chunk: notice });
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      return;
    }
    outputBytes += buf.length;
    socket.emit("exec:output", { runId, stream: streamName, chunk: buf.toString("utf8") });
  };
  child.stdout.on("data", onChunk("stdout"));
  child.stderr.on("data", onChunk("stderr"));

  child.on("error", (err) => {
    if (finished) return;
    finished = true;
    cleanup();
    socket.emit("exec:end", {
      ...runInfo,
      exitCode: -1,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      error: String(err.message),
    });
  });

  child.on("close", (code) => {
    if (finished) return;
    finished = true;
    cleanup();
    socket.emit("exec:end", {
      ...runInfo,
      exitCode: code ?? (killed ? -1 : 0),
      durationMs: Date.now() - startedAt,
      timedOut: killed,
    });
  });

  return { ok: true, runId };
}
