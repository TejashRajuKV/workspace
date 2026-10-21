"use client";

// Import a workspace bundle (.zip) exported from Infinite Workspace.
// Step 1: choose a file and inspect conflicts (dry run).
// Step 2: pick a conflict policy and apply.

import { useRef, useState } from "react";
import { FileArchive, Loader2, Upload, X } from "lucide-react";
import { toast } from "./Feedback";
import { importCanvasObjects } from "./canvas-engine/importCanvas";
import { useCode } from "@/state/code";

const POLICIES = [
  ["skip", "Skip existing files"],
  ["overwrite", "Overwrite existing files"],
  ["rename", "Keep both (add a suffix)"],
];

async function readError(res) {
  const data = await res.json().catch(() => ({}));
  return String(data.error || `HTTP ${res.status}`);
}

export default function ImportDialog({ workspaceId, open, onClose }) {
  const [file, setFile] = useState(null);
  const [dry, setDry] = useState(null);
  const [policy, setPolicy] = useState("skip");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  if (!open) return null;

  const reset = () => {
    setFile(null);
    setDry(null);
    setPolicy("skip");
  };

  const inspect = async (f) => {
    setBusy(true);
    setDry(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/import.zip?dryRun=1`, {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: f,
      });
      if (!res.ok) throw new Error(await readError(res));
      setDry(await res.json());
    } catch (err) {
      toast(err.message, "error", 8000);
      setFile(null);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/import.zip?policy=${encodeURIComponent(policy)}`,
        {
          method: "POST",
          headers: { "content-type": "application/zip" },
          body: file,
        }
      );
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      if (data.canvas?.objects?.length) {
        const result = importCanvasObjects(data.canvas.objects);
        if (result.added) toast(`Added ${result.added} board objects`, "success");
      }
      const refresh = await fetch(`/api/workspaces/${workspaceId}/bootstrap`);
      if (refresh.ok) {
        const boot = await refresh.json();
        useCode.getState().setDocs(boot.docs || []);
      }
      const s = data.summary || {};
      toast(
        `Imported ${s.created || 0} new, ${s.overwritten || 0} updated, ${s.renamed || 0} renamed`,
        "success",
        7000
      );
      reset();
      onClose();
    } catch (err) {
      toast(err.message, "error", 8000);
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
        aria-label="Import workspace ZIP"
        className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-xl border border-[#43272e] bg-[#201317] shadow-2xl"
      >
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[#43272e]">
          <FileArchive size={18} className="text-[#f4a261]" />
          <div>
            <h2 className="text-sm font-semibold text-[#fbeeda]">Import ZIP</h2>
            <p className="text-[11px] text-[#c3a596]">Load a workspace bundle or a folder of files.</p>
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
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              if (f.size > 25 * 1024 * 1024) {
                toast("Archive is larger than 25MB", "error");
                return;
              }
              setFile(f);
              await inspect(f);
            }}
          />
          <button
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-[#553038] bg-[#2a181d] px-3 py-6 text-xs text-[#c3a596] hover:border-amber-500/50 hover:text-[#fbeeda]"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            <Upload size={16} />
            {file ? file.name : "Choose a .zip file"}
          </button>

          {busy && !dry && (
            <div className="flex items-center gap-2 text-xs text-[#c3a596]">
              <Loader2 size={14} className="animate-spin" /> Reading archive…
            </div>
          )}

          {dry && (
            <div className="space-y-3">
              <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3 text-[11px] text-[#c3a596] space-y-1">
                <div>
                  <span className="text-[#fbeeda]">{dry.files.length}</span> files found
                  {dry.canvasObjects ? `, ${dry.canvasObjects} board objects` : ""}
                </div>
                <div>
                  <span className={dry.conflicts.length ? "text-amber-400" : "text-emerald-400"}>
                    {dry.conflicts.length}
                  </span>{" "}
                  path conflicts
                </div>
                {dry.skipped?.length > 0 && (
                  <div className="text-[#a1847a]">{dry.skipped.length} entries skipped (binary, size or path)</div>
                )}
              </div>

              {dry.conflicts.length > 0 && (
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-[#c3a596]">
                    On conflict
                  </span>
                  <div className="space-y-1">
                    {POLICIES.map(([value, label]) => (
                      <label key={value} className="flex items-center gap-2 text-[11px] text-[#c3a596] cursor-pointer">
                        <input
                          type="radio"
                          name="importpolicy"
                          className="accent-amber-500"
                          checked={policy === value}
                          onChange={() => setPolicy(value)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <button className="btn btn-primary px-3.5 py-1.5" onClick={apply} disabled={busy || !dry.files.length}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {busy ? "Importing…" : `Import ${dry.files.length} file${dry.files.length === 1 ? "" : "s"}`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
