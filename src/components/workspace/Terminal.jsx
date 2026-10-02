"use client";

// Terminal: streams code execution from the collaboration service and
// supports a small set of local commands (run / node / python / ls / clear).
// Execution runs in controlled child processes with timeout + output caps —
// documented in docs/architecture.md.

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
    const offEnd = on("exec:end", ({ exitCode, durationMs, timedOut, error }) => {
      setRunning(false);
      runIdRef.current = null;
      if (error) push("err", `error: ${error}`);
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

  const runFile = async (docId, language) => {
    if (role === "viewer") {
      push("err", "viewers cannot run code");
      return;
    }
    if (running) {
      push("err", "a program is already running");
      return;
    }
    const res = await emitAck("exec:start", { fileId: docId, language }, 6000);
    if (res?.error) {
      push("err", res.error);
      return;
    }
    setRunning(true);
  };

  const handleCommand = async (raw) => {
    const cmd = raw.trim();
    if (!cmd) return;
    push("cmd", `$ ${cmd}`);
    const [head, ...rest] = cmd.split(/\s+/);
    const arg = rest.join(" ");
    switch (head) {
      case "help":
        push("sys", "commands: run <file> · node <file.js> · python <file.py> · ls · clear · help");
        break;
      case "clear":
        setLines([]);
        break;
      case "ls": {
        const names = docs.map((d) => (d.isFolder ? d.path : d.path)).join("\n");
        push("out", names || "(empty workspace)");
        break;
      }
      case "run":
      case "node":
      case "python":
      case "python3": {
        let doc = null;
        if (arg) {
          doc = docs.find((d) => d.path === arg || d.path === arg + (head === "run" ? "" : ""));
        }
        if (!doc && !arg && activeDocId) doc = docs.find((d) => d.id === activeDocId);
        if (!doc) {
          push("err", `file not found: ${arg || "(no active file)"}`);
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
        await runFile(doc.id, lang);
        break;
      }
      default:
        push("err", `unknown command: ${head} (try \`help\`)`);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0d13] border-t border-[#232b3b]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#1a2130] flex-none">
        <span className="text-[11px] font-semibold tracking-wider text-[#8b94a7] uppercase">
          Terminal {running && <span className="text-emerald-400 normal-case">· running</span>}
        </span>
        <button
          className="text-[11px] px-2 py-0.5 rounded bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 font-medium"
          onClick={() => (activeDocId ? runFile(activeDocId, null) : push("err", "no active file"))}
          disabled={running || role === "viewer"}
        >
          ▶ Run active file
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2">
        {lines.map((l, i) => (
          <div
            key={i}
            className={`term-line ${
              l.kind === "err"
                ? "text-red-400"
                : l.kind === "sys"
                  ? "text-[#8b94a7]"
                  : l.kind === "cmd"
                    ? "text-emerald-300"
                    : "text-[#cbd2e0]"
            }`}
          >
            {l.text}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 border-t border-[#1a2130] flex-none">
        <span className="text-emerald-400 font-mono text-xs select-none">$</span>
        <input
          className="flex-1 bg-transparent outline-none text-[#e6e9ef] font-mono text-xs"
          value={input}
          placeholder="run main.js …"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleCommand(input);
              setInput("");
            }
          }}
        />
      </div>
    </div>
  );
}
