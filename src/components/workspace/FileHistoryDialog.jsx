"use client";

// Per-file version history with a diff view and restore.

import { useCallback, useEffect, useState } from "react";
import { DiffEditor, loader } from "@monaco-editor/react";
import { History, Loader2, RotateCcw, X } from "lucide-react";
import { useBoard } from "@/state/board";
import { useCode } from "@/state/code";
import { toast, confirmDialog } from "./Feedback";

loader.config({ paths: { vs: "/monaco/vs" } });

async function readError(res) {
  const data = await res.json().catch(() => ({}));
  return String(data.error || `HTTP ${res.status}`);
}

export default function FileHistoryDialog({ workspaceId, docId, open, onClose }) {
  const role = useBoard((s) => s.role);
  const [list, setList] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState(null);
  const [busy, setBusy] = useState(false);

  const doc = useCode((s) => s.docs.find((d) => d.id === docId));

  const selectVersion = useCallback(
    async (version) => {
      setSelected(version);
      setContent(null);
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/files/${docId}/versions/${version}`);
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json();
        setContent(data.content);
      } catch (err) {
        toast(err.message, "error");
      }
    },
    [workspaceId, docId]
  );

  useEffect(() => {
    if (!open || !docId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setList(null);
      setSelected(null);
      setContent(null);
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/files/${docId}/versions`);
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json();
        if (cancelled) return;
        setList(data);
        const latest = data.versions[data.versions.length - 1];
        if (latest) selectVersion(latest.version);
      } catch (err) {
        if (!cancelled) toast(err.message, "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, docId, workspaceId, selectVersion]);

  const restore = async () => {
    if (!selected) return;
    const ok = await confirmDialog({
      title: `Restore version ${selected}?`,
      message: "The current content is replaced. Everyone editing this file sees the change.",
      confirmLabel: "Restore",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files/${docId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: selected }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const refresh = await fetch(`/api/workspaces/${workspaceId}/bootstrap`);
      if (refresh.ok) {
        const boot = await refresh.json();
        useCode.getState().setDocs(boot.docs || []);
      }
      toast(`Restored ${doc?.path || "file"} to revision ${selected}`, "success");
    } catch (err) {
      toast(err.message, "error", 8000);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const current = doc?.content ?? "";

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/65 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="w-full max-w-5xl h-[80vh] flex flex-col rounded-xl border border-[#43272e] bg-[#201317] shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2.5 px-5 py-3 border-b border-[#43272e] flex-none">
          <History size={17} className="text-[#f4a261]" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[#fbeeda] truncate">{doc?.path || "File"} — history</h2>
            <p className="text-[11px] text-[#c3a596]">
              {list ? `${list.versions.length} recorded revisions` : "Loading revisions…"}
            </p>
          </div>
          <button
            className="ml-auto p-1.5 rounded-md text-[#a1847a] hover:text-white hover:bg-[#332026]"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="w-56 flex-none border-r border-[#43272e] overflow-y-auto">
            {loading && (
              <div className="flex items-center gap-2 p-3 text-xs text-[#c3a596]">
                <Loader2 size={13} className="animate-spin" /> Loading…
              </div>
            )}
            {list?.versions?.length === 0 && (
              <div className="p-3 text-[11px] text-[#a1847a]">
                No edits recorded since history capture began.
              </div>
            )}
            {list?.versions
              ?.slice()
              .reverse()
              .map((v) => (
                <button
                  key={v.version}
                  className={`w-full text-left px-3 py-2 border-b border-[#332026] ${
                    selected === v.version ? "bg-amber-500/15" : "hover:bg-[#2a181d]"
                  }`}
                  onClick={() => selectVersion(v.version)}
                >
                  <div className="text-[11px] text-[#fbeeda]">
                    rev {v.version} {v.version === list.currentVersion ? "(current)" : ""}
                  </div>
                  <div className="text-[10px] text-[#c3a596]">
                    {v.by} · {new Date(v.at).toLocaleString()}
                  </div>
                </button>
              ))}
          </div>

          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#43272e] flex-none text-[11px] text-[#c3a596]">
              <span>Comparing selected revision (left) with current content (right)</span>
              <button
                className="ml-auto btn btn-ghost px-2.5 py-1"
                onClick={restore}
                disabled={busy || !selected || role === "viewer"}
                title={role === "viewer" ? "Viewers cannot restore" : "Restore this revision"}
              >
                <RotateCcw size={12} /> Restore revision {selected}
              </button>
            </div>
            <div className="flex-1 min-h-0">
              {content === null && selected != null ? (
                <div className="flex items-center gap-2 p-3 text-xs text-[#c3a596]">
                  <Loader2 size={13} className="animate-spin" /> Loading revision…
                </div>
              ) : selected == null ? (
                <div className="p-3 text-[11px] text-[#a1847a]">Pick a revision on the left.</div>
              ) : (
                <DiffEditor
                  height="100%"
                  theme="iw-dark"
                  original={content}
                  modified={current}
                  options={{
                    readOnly: true,
                    fontSize: 12,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    renderSideBySide: true,
                    automaticLayout: true,
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
