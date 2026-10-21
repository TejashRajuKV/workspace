// ============================================================
// Code execution without Docker — controlled child processes.
//
// Threat model (documented in docs/architecture.md): this is a LOCAL,
// trusted-user development feature, not a public sandbox. Protections:
//   - fixed language allowlist (JS/TS → node, Python → python3)
//   - files materialized into a fresh temp dir; paths validated
//   - timeout (SIGKILL), combined output cap, 1 run per user, global cap
//   - minimal environment, no shell, no privileged operations
// ============================================================

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./db.js";
import { validateFilePath } from "../../src/shared/protocol.js";

const EXEC_TIMEOUT_MS = 8000;
const MAX_OUTPUT = 128 * 1024;
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

// Node runs JS directly and, since v22.18/v23.6, strips TypeScript types
// natively (erasable syntax only — no enums/namespaces/parameter properties).
const JS_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];
const TS_EXTENSIONS = [".ts", ".mts", ".cts"];

const runningPerUser = new Map(); // userId → count
let runningTotal = 0;
const MAX_GLOBAL = 4;

// Live run registry (cancel / stdin) + per-workspace execution history.
const runs = new Map(); // runId → { child, userId, room, socket, entryPath, language, startedAt, finished }
const history = new Map(); // roomId → [{ runId, entryPath, language, exitCode, durationMs, startedAt, by }]
const MAX_HISTORY = 50;

function rememberRun(room, record) {
  if (!history.has(room)) history.set(room, []);
  const list = history.get(room);
  list.unshift(record);
  if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
}

export function listRuns(room, fileId) {
  const list = history.get(room) || [];
  if (!fileId) return list;
  return list.filter((r) => r.fileId === fileId);
}

export function cancelExecution(socket, runId) {
  const run = runs.get(runId);
  if (!run) return { error: "Run not found" };
  if (run.userId !== socket.data.userId) return { error: "Not your run" };
  if (run.state.finished) return { error: "Run already finished" };
  run.state.killed = true;
  run.state.canceled = true;
  try {
    run.child.kill("SIGKILL");
  } catch {}
  return { ok: true };
}

export function sendExecutionInput(socket, runId, data) {
  const run = runs.get(runId);
  if (!run) return { error: "Run not found" };
  if (run.userId !== socket.data.userId) return { error: "Not your run" };
  if (run.state.finished) return { error: "Run already finished" };
  if (!run.child.stdin || run.child.stdin.destroyed) return { error: "This run does not accept input" };
  const text = String(data ?? "").slice(0, 4096);
  try {
    run.child.stdin.write(text);
  } catch {
    return { error: "Could not write to stdin" };
  }
  return { ok: true };
}

// Windows ships a "python.exe"/"python3.exe" stub in WindowsApps that opens the
// Microsoft Store and exits 9009. Resolve a *real* interpreter once, preferring
// the launcher and absolute paths so the stub can never shadow an installed
// Python. On other platforms `python3` is the conventional name.
let pythonRuntime;
function resolvePython() {
  if (pythonRuntime !== undefined) return pythonRuntime;
  const candidates =
    process.platform === "win32"
      ? [
          { cmd: "py", args: ["-3"] },
          { cmd: "python", args: [] },
          { cmd: "python3", args: [] },
        ]
      : [
          { cmd: "python3", args: [] },
          { cmd: "python", args: [] },
        ];

  const isStoreStub = (p) => /[\\/]WindowsApps[\\/]python/i.test(p);
  const whichCmd = process.platform === "win32" ? "where" : "which";

  for (const cand of candidates) {
    const probe = spawnSync(cand.cmd, [...cand.args, "--version"], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    if (probe.error || probe.status !== 0) continue;

    let resolved = cand;
    const which = spawnSync(whichCmd, [cand.cmd], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    if (which.status === 0) {
      const real = String(which.stdout || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((p) => p && !isStoreStub(p));
      if (real) resolved = { cmd: real, args: cand.args };
    }
    pythonRuntime = resolved;
    return pythonRuntime;
  }
  pythonRuntime = null;
  return pythonRuntime;
}

export function startExecution(io, socket, room, { fileId, language, interactive }) {
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
    language || (ext === ".py" ? "python" : JS_EXTENSIONS.includes(ext) ? "javascript" : null);
  if (lang !== "javascript" && lang !== "python")
    return { error: "Unsupported language — use .js, .ts or .py" };
  if (lang === "javascript" && !JS_EXTENSIONS.includes(ext))
    return { error: "JavaScript/TypeScript entry must be .js, .mjs, .cjs, .ts, .mts or .cts" };
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
  let cmd;
  let args;
  if (lang === "javascript") {
    cmd = process.execPath || "node";
    args = [entryAbs];
    if (TS_EXTENSIONS.includes(ext) && !process.features.typescript) {
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major > 22 || (major === 22 && minor >= 6)) {
        args.unshift("--experimental-strip-types");
      } else {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return {
          error: `TypeScript requires Node 22.6+ (server is running ${process.version})`,
        };
      }
    }
  } else {
    const py = resolvePython();
    if (!py) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return {
        error:
          "Python runtime not found — install Python 3 and make sure `python` or `py` is on PATH",
      };
    }
    cmd = py.cmd;
    args = [...py.args, entryAbs];
  }

  let child;
  try {
    child = spawn(cmd, args, {
      cwd: tmpDir,
      env: {
        PATH: process.env.PATH,
        HOME: tmpDir,
        TMP: tmpDir,
        TEMP: tmpDir,
        SYSTEMROOT: process.env.SYSTEMROOT,
        WINDIR: process.env.WINDIR,
        LANG: "C.UTF-8",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
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
  const state = { killed: false, finished: false, canceled: false, by: socket.data.username || null };

  const runInfo = { runId, language: lang, entryPath: entry.path };
  runs.set(runId, {
    child,
    state,
    userId,
    room,
    socket,
    entryPath: entry.path,
    fileId,
    language: lang,
    startedAt,
  });
  rememberRun(room, {
    runId,
    fileId,
    entryPath: entry.path,
    language: lang,
    exitCode: null,
    durationMs: null,
    startedAt,
    by: socket.data.username || "unknown",
    running: true,
  });
  socket.emit("exec:started", runInfo);

  const timer = setTimeout(() => {
    state.killed = true;
    try {
      child.kill("SIGKILL");
    } catch {}
  }, EXEC_TIMEOUT_MS);

  const cleanup = () => {
    runningTotal--;
    runningPerUser.set(userId, Math.max(0, (runningPerUser.get(userId) || 1) - 1));
    clearTimeout(timer);
    runs.delete(runId);
    setTimeout(() => fs.rmSync(tmpDir, { recursive: true, force: true }), 200);
  };

  const finalize = (payload) => {
    const rec = (history.get(room) || []).find((r) => r.runId === runId);
    if (rec) {
      rec.exitCode = payload.exitCode;
      rec.durationMs = payload.durationMs;
      rec.running = false;
      rec.timedOut = !!payload.timedOut;
      rec.canceled = !!payload.canceled;
    }
    socket.emit("exec:end", payload);
  };

  const onChunk = (streamName) => (chunk) => {
    if (state.finished) return;
    const buf = Buffer.from(chunk);
    if (outputBytes + buf.length > MAX_OUTPUT) {
      const notice = "\n…output limit reached, process terminated…\n";
      socket.emit("exec:output", { runId, stream: streamName, chunk: notice });
      state.killed = true;
      state.canceled = true;
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
    if (state.finished) return;
    state.finished = true;
    cleanup();
    finalize({
      ...runInfo,
      exitCode: -1,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      canceled: state.canceled,
      error: String(err.message),
    });
  });

  child.on("close", (code) => {
    if (state.finished) return;
    state.finished = true;
    cleanup();
    finalize({
      ...runInfo,
      exitCode: state.canceled ? -1 : code ?? (state.killed ? -1 : 0),
      durationMs: Date.now() - startedAt,
      timedOut: state.killed,
      canceled: state.canceled,
    });
  });

  return { ok: true, runId };
}
