"use client";

// Workspace analytics: 30-day activity, totals and top editors.

import { useEffect, useState } from "react";
import { BarChart3, Loader2, X } from "lucide-react";
import { toast } from "./Feedback";

function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

const STAT_KEYS = [
  ["files", "Files"],
  ["folders", "Folders"],
  ["canvasObjects", "Board objects"],
  ["comments", "Comment threads"],
  ["operations", "Board edits (30d)"],
  ["documentOperations", "File edits (30d)"],
  ["assets", "Images"],
  ["members", "Members"],
];

export default function AnalyticsDialog({ workspaceId, open, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/analytics`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (alive) setData(json);
      } catch (err) {
        if (alive) toast(err.message, "error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, workspaceId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const totals = data?.totals || {};
  const activity = data?.activity || [];
  // The server sends a dense oldest→newest timeline; fall back to the sparse
  // activity list for older responses.
  const days = data?.series?.length ? data.series : activity;
  const peak = Math.max(1, ...days.map((d) => d.count));

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/65 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Workspace analytics"
        className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-xl border border-[#43272e] bg-[#201317] shadow-2xl"
      >
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[#43272e] sticky top-0 bg-[#201317] z-10">
          <BarChart3 size={18} className="text-[#f4a261]" />
          <div>
            <h2 className="text-sm font-semibold text-[#fbeeda]">Analytics</h2>
            <p className="text-[11px] text-[#c3a596]">Last 30 days of activity in this workspace.</p>
          </div>
          <button
            className="ml-auto p-1.5 rounded-md text-[#a1847a] hover:text-white hover:bg-[#332026]"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {loading && !data ? (
            <div className="flex items-center gap-2 text-xs text-[#c3a596]">
              <Loader2 size={14} className="animate-spin" /> Crunching numbers…
            </div>
          ) : data ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {STAT_KEYS.map(([key, label]) => (
                  <div key={key} className="rounded-lg border border-[#43272e] bg-[#2a181d] px-3 py-2">
                    <div className="text-lg font-semibold text-[#fbeeda]">{totals[key] ?? 0}</div>
                    <div className="text-[10px] uppercase tracking-wide text-[#a1847a]">{label}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3">
                <div className="mb-2 flex items-center justify-between text-[11px] text-[#c3a596]">
                  <span>Daily edits</span>
                  <span>
                    {fmtBytes(totals.fileBytes)} of code · {fmtBytes(totals.assetBytes)} of images
                  </span>
                </div>
                {activity.length === 0 ? (
                  <p className="text-[11px] text-[#a1847a]">No activity recorded in this window.</p>
                ) : (
                  <>
                    <div className="flex h-24 items-end gap-[2px]">
                      {days.map((a) => (
                        <div
                          key={a.date}
                          className="flex-1 min-w-0 rounded-t bg-[#f4a261]/70 hover:bg-[#f4a261]"
                          style={{ height: `${a.count ? Math.max(3, (a.count / peak) * 100) : 1}%` }}
                          title={`${a.date}: ${a.count} edit${a.count === 1 ? "" : "s"}`}
                        />
                      ))}
                    </div>
                    <div className="mt-1 flex justify-between text-[10px] text-[#7a625a]">
                      <span>{days[0].date}</span>
                      <span>{days[days.length - 1].date}</span>
                    </div>
                  </>
                )}
              </div>

              <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3">
                <div className="mb-2 text-[11px] text-[#c3a596]">Top editors</div>
                {(data.topEditors || []).length === 0 ? (
                  <p className="text-[11px] text-[#a1847a]">No edits yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {data.topEditors.map((e) => (
                      <div key={e.user.id} className="flex items-center gap-2 text-[11px]">
                        <span
                          className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white"
                          style={{ background: e.user.color || "#7a5a52" }}
                        >
                          {(e.user.username || "??").slice(0, 2).toUpperCase()}
                        </span>
                        <span className="text-[#fbeeda]">{e.user.username || e.user.id}</span>
                        <div className="mx-2 h-1.5 flex-1 overflow-hidden rounded-full bg-[#170d12]">
                          <div
                            className="h-full rounded-full bg-[#f6c177]"
                            style={{ width: `${(e.count / (data.topEditors[0]?.count || 1)) * 100}%` }}
                          />
                        </div>
                        <span className="text-[#a1847a]">{e.count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
