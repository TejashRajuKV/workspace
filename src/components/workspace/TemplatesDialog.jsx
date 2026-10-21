"use client";

// Workspace templates: snapshot the current workspace, or delete saved ones.
// Applying a template happens when creating a workspace (dashboard).

import { useEffect, useState } from "react";
import { LayoutTemplate, Loader2, Plus, Trash2, X } from "lucide-react";
import { toast, confirmDialog } from "./Feedback";

async function readError(res) {
  const data = await res.json().catch(() => ({}));
  return String(data.error || `HTTP ${res.status}`);
}

export default function TemplatesDialog({ workspaceId, open, onClose }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/templates");
      if (res.ok) setTemplates((await res.json()).templates || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the form each time the dialog opens
    setName("");
    setDescription("");
    load();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const save = async () => {
    if (!name.trim()) {
      toast("Give the template a name", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), workspaceId }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast("Template saved", "success");
      setName("");
      setDescription("");
      await load();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tpl) => {
    const ok = await confirmDialog({
      title: `Delete template "${tpl.name}"?`,
      message: "Workspaces created from it are not affected.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/templates/${tpl.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      await load();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/65 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Templates"
        className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-xl border border-[#43272e] bg-[#201317] shadow-2xl"
      >
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[#43272e] sticky top-0 bg-[#201317] z-10">
          <LayoutTemplate size={18} className="text-[#f4a261]" />
          <div>
            <h2 className="text-sm font-semibold text-[#fbeeda]">Templates</h2>
            <p className="text-[11px] text-[#c3a596]">
              Snapshot this workspace&apos;s files and board to reuse later.
            </p>
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

        <div className="p-5 space-y-4">
          <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3 space-y-2">
            <input
              className="field w-full"
              placeholder="Template name — e.g. Sprint kickoff"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
            <input
              className="field w-full"
              placeholder="Optional description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={240}
            />
            <button className="btn btn-primary px-3 py-1.5" onClick={save} disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              Save current workspace as template
            </button>
          </div>

          <div>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#c3a596]">
              Saved templates {loading ? "" : `(${templates.length})`}
            </h3>
            {templates.length === 0 ? (
              <p className="text-xs text-[#a1847a]">
                No templates yet. Pick one when creating a workspace on the dashboard.
              </p>
            ) : (
              <div className="space-y-1">
                {templates.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 rounded-lg border border-[#43272e] bg-[#2a181d] px-2.5 py-2"
                  >
                    <LayoutTemplate size={13} className="flex-none text-[#a1847a]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-[#fbeeda]">{t.name}</div>
                      <div className="truncate text-[10px] text-[#a1847a]">
                        {t.description || "No description"} · {t.fileCount} file{t.fileCount === 1 ? "" : "s"} ·{" "}
                        {t.canvasCount} object{t.canvasCount === 1 ? "" : "s"}
                      </div>
                    </div>
                    <button
                      className="p-1 rounded text-[#a1847a] hover:text-red-400"
                      title="Delete template"
                      onClick={() => remove(t)}
                      disabled={busy}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
