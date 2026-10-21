"use client";

// Trash: soft-deleted files/folders inside a workspace, with restore + purge.

import { useEffect, useState } from "react";
import { FolderMinus, Loader2, RotateCcw, Trash2, Trash, X } from "lucide-react";
import { toast, confirmDialog } from "./Feedback";

async function readError(res) {
  const data = await res.json().catch(() => ({}));
  return String(data.error || `HTTP ${res.status}`);
}

export default function TrashDialog({ workspaceId, open, onClose, onChanged }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/trash`);
      if (!res.ok) throw new Error(await readError(res));
      setState(await res.json());
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load; state settles after the fetch
    load();
  }, [open, workspaceId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const restore = async (doc) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/trash/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: doc.id }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast(`Restored ${doc.path}`, "success");
      await load();
      onChanged?.();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const purge = async (doc) => {
    const ok = await confirmDialog({
      title: `Delete ${doc.path} permanently?`,
      message: "This cannot be undone.",
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/trash?documentId=${encodeURIComponent(doc.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(await readError(res));
      await load();
      onChanged?.();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const emptyTrash = async () => {
    const ok = await confirmDialog({
      title: "Empty the trash?",
      message: "Every deleted file in this workspace will be removed permanently.",
      confirmLabel: "Empty trash",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/trash`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      toast("Trash emptied", "success");
      await load();
      onChanged?.();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const docs = state?.documents || [];

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/65 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Trash"
        className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-xl border border-[#43272e] bg-[#201317] shadow-2xl"
      >
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[#43272e] sticky top-0 bg-[#201317] z-10">
          <Trash size={18} className="text-[#f4a261]" />
          <div>
            <h2 className="text-sm font-semibold text-[#fbeeda]">Trash</h2>
            <p className="text-[11px] text-[#c3a596]">Deleted files can be restored until purged.</p>
          </div>
          <button
            className="ml-auto p-1.5 rounded-md text-[#a1847a] hover:text-white hover:bg-[#332026]"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {loading && !state ? (
            <div className="flex items-center gap-2 text-xs text-[#c3a596]">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : (
            <>
              {Number(state?.canvasTrash) > 0 && (
                <p className="rounded-lg border border-[#43272e] bg-[#2a181d] px-3 py-2 text-[11px] text-[#c3a596]">
                  {state.canvasTrash} deleted board object{state.canvasTrash === 1 ? "" : "s"} (restored with the
                  board version history).
                </p>
              )}

              {docs.length === 0 ? (
                <p className="text-xs text-[#a1847a]">Trash is empty.</p>
              ) : (
                <div className="space-y-1">
                  {docs.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center gap-2 rounded-lg border border-[#43272e] bg-[#2a181d] px-2.5 py-2"
                    >
                      <FolderMinus size={13} className="flex-none text-[#a1847a]" />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#fbeeda]">
                        {d.path}
                        {d.isFolder ? "/" : ""}
                      </span>
                      <span className="flex-none text-[10px] text-[#7a5a52]">
                        {d.deletedAt > 0 ? new Date(d.deletedAt).toLocaleDateString() : "—"}
                      </span>
                      <button
                        className="p-1 rounded text-[#a1847a] hover:text-amber-400"
                        title="Restore"
                        onClick={() => restore(d)}
                        disabled={busy}
                      >
                        <RotateCcw size={13} />
                      </button>
                      <button
                        className="p-1 rounded text-[#a1847a] hover:text-red-400"
                        title="Delete permanently"
                        onClick={() => purge(d)}
                        disabled={busy}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {docs.length > 0 && (
                <button className="btn btn-ghost px-3 py-1.5 text-red-400 hover:text-red-300" onClick={emptyTrash} disabled={busy}>
                  <Trash size={13} /> Empty trash
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
