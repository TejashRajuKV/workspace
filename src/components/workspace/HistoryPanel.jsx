"use client";

// Version history: the operation log IS the history. Restore rebuilds the
// state at a version (snapshot + replay) and re-emits the diff as operations.

import { useEffect, useState } from "react";
import { X, RotateCcw } from "lucide-react";
import { opSummary } from "@/shared/protocol";

export default function HistoryPanel({ workspaceId, onClose }) {
  const [ops, setOps] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/versions?limit=120`);
    if (res.ok) {
      const data = await res.json();
      setOps(data.operations || []);
    }
  };

  useEffect(() => {
    load();
  }, [workspaceId]);

  const restore = async (version) => {
    if (!confirm(`Restore the board to version ${version}?\nCurrent state is kept in the operation log (this is itself undoable per user).`))
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) alert(data.error || "Restore failed");
      else load();
    } finally {
      setBusy(false);
    }
  };

  const fmt = (ts) => {
    try {
      return new Date(ts).toLocaleTimeString();
    } catch {
      return "";
    }
  };

  return (
    <aside className="w-72 flex-none border-l border-[#232b3b] bg-[#0d1119] flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#232b3b]">
        <span className="text-[11px] font-semibold tracking-wider text-[#8b94a7] uppercase">
          Operation history
        </span>
        <button className="p-1 rounded hover:bg-[#1b2230] text-[#8b94a7]" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {!ops && <div className="text-xs text-[#8b94a7] px-2">Loading…</div>}
        {ops && ops.length === 0 && (
          <div className="text-xs text-[#8b94a7] px-2 py-3 leading-relaxed">
            No operations yet — draw something on the board.
          </div>
        )}
        {ops &&
          ops.map((op) => (
            <div
              key={op.version}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[#161b26] text-xs"
            >
              <span
                className="w-2 h-2 rounded-full flex-none"
                style={{ background: op.user?.color || "#888" }}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[#e6e9ef] truncate">
                  <span className="font-medium">{op.user?.username}</span>{" "}
                  <span className="text-[#8b94a7]">{opSummary(op)}</span>
                </div>
                <div className="text-[10px] text-[#5b6478]">
                  v{op.version} · {fmt(op.createdAt)}
                </div>
              </div>
              <button
                title="Restore board to this version"
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[#1b2230] text-[#8b94a7] hover:text-emerald-400"
                disabled={busy}
                onClick={() => restore(op.version)}
              >
                <RotateCcw size={13} />
              </button>
            </div>
          ))}
      </div>
      <div className="px-3 py-2 border-t border-[#232b3b] text-[10px] text-[#5b6478] leading-relaxed">
        Snapshots are taken every 100 operations. Restore replays snapshot +
        operations and broadcasts the diff.
      </div>
    </aside>
  );
}
