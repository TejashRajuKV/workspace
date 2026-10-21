"use client";

// Terminal: streams code execution from the collaboration service and
// supports a small set of local commands (run / node / python / ls / clear).
// Execution runs in controlled child processes with timeout + output caps —
// documented in docs/architecture.md.
//
// While a program runs, typed input is piped to its stdin (prefix a line with
// `/` to run a local command instead). `run --interactive <file>` starts a
// program with a writable stdin.

import { useEffect, useRef, useState } from "react";
import { useCode } from "@/state/code";
import { useBoard } from "@/state/board";
import { on, emitAck } from "@/lib/socket";

const MAX_LINES = 800;

export default function Terminal({ workspaceId }) {
  const [lines, setLines] = useState([
    { kind: "sys", text: "Infinite Workspace terminal — type `help` for commands." },
  ]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [cmdHistory, setCmdHistory] = useState([]);
  const historyIdxRef = useRef(-1);
  const scrollRef = useRef(null);
  const runIdRef = useRef(null);
  const activeDocId = useCode((s) => s.activeDocId);
  const docs = useCode((s) => s.docs);
  const role = useBoard((s) => s.role);

  const push = (kind, text) => {
    setLines((prev) => {
      const next = [...prev, { kind, text }];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  };

  useEffect(() => {
    const offStarted = on("exec:started", ({ runId, entryPath }) => {
      runIdRef.current = runId;
      push("cmd", `▶ running ${entryPath} …`);
    });
    const offOut = on("exec:output", ({ stream, chunk }) => {
      push(stream === "stderr" ? "err" : "out", chunk.replace(/\n$/, ""));
    });
    const offEnd = on("exec:end", ({ exitCode, durationMs, timedOut, canceled, error }) => {
      setRunning(false);
      runIdRef.current = null;
      if (error) push("err", `error: ${error}`);
      else if (canceled) push("sys", `■ canceled · ${durationMs}ms`);
      else if (timedOut) push("err", `✗ terminated (timeout, ${durationMs}ms)`);
      else if (exitCode === 0) push("sys", `✓ exit 0 · ${durationMs}ms`);
      else push("err", `✗ exit ${exitCode} · ${durationMs}ms`);
    });
    return () => {
      offStarted();
      offOut();
      offEnd();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  const runFile = async (docId, language, interactive = false) => {
    if (role === "viewer") {
      push("err", "viewers cannot run code");
      return;
    }
    if (running) {
      push("err", "a program is already running");
      return;
    }
    const res = await emitAck("exec:start", { fileId: docId, language, interactive }, 6000);
    if (res?.error) {
      push("err", res.error);
      return;
    }
    setRunning(true);
    if (interactive) push("sys", "interactive run — type to send stdin (prefix `/` for a command)");
  };

  const cancel = async () => {
    if (!runIdRef.current) return;
    const res = await emitAck("exec:cancel", { runId: runIdRef.current }, 4000);
    if (res?.error) push("err", res.error);
  };

  const showHistory = async () => {
    const res = await emitAck("exec:history", {}, 4000);
    const runs = res?.runs || [];
    if (!runs.length) {
      push("sys", "no previous runs");
      return;
    }
    for (const r of runs.slice(0, 12)) {
      push(
        r.running ? "out" : r.exitCode === 0 ? "sys" : "err",
        `${r.running ? "…" : r.exitCode === 0 ? "✓" : "✗"} ${r.entryPath} · ${r.by} · ${
          r.durationMs != null ? r.durationMs + "ms" : "running"
        }`
      );
    }
  };

  const handleCommand = async (raw) => {
    const cmd = raw.trim();
    if (!cmd) return;
    setCmdHistory((h) => [...h.slice(-99), cmd]);
    historyIdxRef.current = -1;
    push("cmd", `$ ${cmd}`);
    const [head, ...rest] = cmd.split(/\s+/);
    const arg = rest.join(" ");
    switch (head) {
      case "help":
        push(
          "sys",
          "commands: run [--interactive] <file> · node <file.js|ts> · python <file.py> · ls · history · clear · help"
        );
        break;
      case "clear":
        setLines([]);
        break;
      case "history":
        await showHistory();
        break;
      case "ls": {
        const names = docs.map((d) => d.path).join("\n");
        push("out", names || "(empty workspace)");
        break;
      }
      case "run":
      case "node":
      case "python":
      case "python3": {
        let interactive = false;
        let target = arg;
        if (target.startsWith("--interactive")) {
          interactive = true;
          target = target.replace("--interactive", "").trim();
        }
        let doc = null;
        if (target) doc = docs.find((d) => d.path === target);
        if (!doc && !target && activeDocId) doc = docs.find((d) => d.id === activeDocId);
        if (!doc) {
          push("err", `file not found: ${target || "(no active file)"}`);
          return;
        }
        if (doc.isFolder) {
          push("err", "cannot run a folder");
          return;
        }
        const lang =
          head === "python" || head === "python3"
            ? "python"
            : head === "node"
              ? "javascript"
              : doc.path.endsWith(".py")
                ? "python"
                : "javascript";
        await runFile(doc.id, lang, interactive);
        break;
      }
      default:
        push("err", `unknown command: ${head} (try \`help\`)`);
    }
  };

  const onEnter = async () => {
    const raw = input;
    setInput("");
    // while a program runs, unprefixed input is piped to its stdin
    if (running && runIdRef.current && !raw.startsWith("/")) {
      const res = await emitAck("exec:input", { runId: runIdRef.current, data: raw + "\n" }, 4000);
      if (res?.error) push("err", res.error);
      else push("cmd", `> ${raw}`);
      return;
    }
    await handleCommand(running && raw.startsWith("/") ? raw.slice(1) : raw);
  };

  const onNav = (dir) => {
    if (!cmdHistory.length) return;
    let idx = historyIdxRef.current;
    idx = dir === "up" ? Math.min(cmdHistory.length - 1, idx + 1) : Math.max(-1, idx - 1);
    historyIdxRef.current = idx;
    setInput(idx < 0 ? "" : cmdHistory[cmdHistory.length - 1 - idx]);
  };

  return (
    <div className="flex flex-col h-full bg-[#140b10] border-t border-[#43272e]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#2e1b20] flex-none">
        <span className="text-[11px] font-semibold tracking-wider text-[#c3a596] uppercase">
          Terminal {running && <span className="text-amber-400 normal-case">· running</span>}
        </span>
        <div className="flex items-center gap-1.5">
          {running && (
            <button
              className="text-[11px] px-2 py-0.5 rounded bg-red-600/20 text-red-300 hover:bg-red-600/30 font-medium"
              onClick={cancel}
            >
              ■ Cancel
            </button>
          )}
          <button
            className="text-[11px] px-2 py-0.5 rounded bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 font-medium"
            onClick={() => (activeDocId ? runFile(activeDocId, null) : push("err", "no active file"))}
            disabled={running || role === "viewer"}
          >
            ▶ Run active file
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2">
        {lines.map((l, i) => (
          <div
            key={i}
            className={`term-line whitespace-pre-wrap break-words ${
              l.kind === "err"
                ? "text-red-400"
                : l.kind === "sys"
                  ? "text-[#c3a596]"
                  : l.kind === "cmd"
                    ? "text-amber-300"
                    : "text-[#f3ddc9]"
            }`}
          >
            {l.text}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 border-t border-[#2e1b20] flex-none">
        <span className="text-amber-400 font-mono text-xs select-none">{running ? "›" : "$"}</span>
        <input
          className="flex-1 bg-transparent outline-none text-[#fbeeda] font-mono text-xs"
          value={input}
          placeholder={running ? "send stdin … (/command to run a command)" : "run main.js …"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter();
            else if (e.key === "ArrowUp") {
              e.preventDefault();
              onNav("up");
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onNav("down");
            }
          }}
        />
      </div>
    </div>
  );
}
