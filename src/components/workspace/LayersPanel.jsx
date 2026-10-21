"use client";

// Layers panel: every board object in stacking order with quick actions.
// Visibility/locking are derived from z-order + comments rather than extra
// per-object flags, so no protocol change is needed.

import { useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Eye,
  Frame,
  Image as ImageIcon,
  MessageSquare,
  MousePointer2,
  SquareStack,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { useBoard, boardRefs, sendPresence } from "@/state/board";
import { OP } from "@/shared/protocol";
import { buildHistoryEntry } from "./canvas-engine/history";
import { confirmDialog } from "./Feedback";

const TYPE_ICON = {
  text: Type,
  sticky: SquareStack,
  image: ImageIcon,
  comment: MessageSquare,
  frame: Frame,
};

const TYPE_LABEL = {
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  arrow: "Arrow",
  freehand: "Drawing",
  connector: "Connector",
};

function label(obj) {
  const d = obj.payload?.data || {};
  if (obj.type === "comment") return (d.text || "Comment").slice(0, 40);
  if (obj.type === "frame") return d.title || "Frame";
  if (obj.type === "image") return d.name || "Image";
  return (d.text || TYPE_LABEL[obj.type] || obj.type).toString().slice(0, 40);
}

export default function LayersPanel({ onClose }) {
  const objects = useBoard((s) => s.objects);
  const selection = useBoard((s) => s.selection);
  const commentCount = useBoard((s) => s.objects.size);
  const [filter, setFilter] = useState("");
  const [onlyComments, setOnlyComments] = useState(false);

  const layers = useMemo(() => {
    const all = [...objects.values()]
      .filter((o) => {
        if (onlyComments && o.type !== "comment") return false;
        if (!filter.trim()) return true;
        return label(o).toLowerCase().includes(filter.trim().toLowerCase());
      })
      .sort((a, b) => (b.z || 0) - (a.z || 0));
    return all;
  }, [objects, filter, onlyComments, commentCount]);

  const select = (obj) => {
    const s = useBoard.getState();
    const keep = s.role !== "viewer";
    s.setSelection([obj.id]);
    if (keep) sendPresence({ selection: [obj.id] });
  };

  const locate = (obj) => {
    const s = useBoard.getState();
    select(obj);
    const canvas = document.querySelector("canvas");
    if (!canvas) return;
    const cam = s.camera;
    const b = obj.payload || {};
    const cx = (b.x || 0) + (b.w || 0) / 2;
    const cy = (b.y || 0) + (b.h || 0) / 2;
    s.setCamera({
      zoom: cam.zoom,
      x: cx - canvas.clientWidth / (2 * cam.zoom),
      y: cy - canvas.clientHeight / (2 * cam.zoom),
    });
    boardRefs.renderer?.markDirty?.();
  };

  const submit = (op) => {
    const s = useBoard.getState();
    if (s.role === "viewer") return;
    const entry = buildHistoryEntry(s.objects, op);
    s.submitOps([op], entry ? [entry] : []);
  };

  const sendToEnd = (obj, front) => {
    let min = Infinity;
    let max = -Infinity;
    for (const o of objects.values()) {
      if (o.id === obj.id) continue;
      min = Math.min(min, o.z || 0);
      max = Math.max(max, o.z || 0);
    }
    if (!Number.isFinite(min)) return;
    submit({ type: OP.ZORDER, oid: obj.id, p: { z: front ? max + 1 : min - 1 } });
  };

  const remove = async (obj) => {
    const ok = await confirmDialog({
      title: "Delete this object?",
      message: label(obj),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    submit({ type: OP.DELETE, oid: obj.id, p: {} });
  };

  const grouped = (obj) => Boolean(obj.payload?.groupId);

  return (
    <aside className="w-60 flex-none border-l border-[#43272e] bg-[#1c1015] flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#43272e]">
        <span className="text-[11px] font-semibold tracking-wider text-[#c3a596] uppercase">Layers</span>
        <button className="p-1 rounded hover:bg-[#332026] text-[#c3a596]" onClick={onClose} title="Close layers">
          <X size={14} />
        </button>
      </div>

      <div className="px-2.5 py-2 border-b border-[#43272e] space-y-1.5">
        <input
          className="field w-full text-xs"
          placeholder="Filter layers…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-[10px] text-[#c3a596] cursor-pointer">
          <input
            type="checkbox"
            className="accent-amber-500"
            checked={onlyComments}
            onChange={(e) => setOnlyComments(e.target.checked)}
          />
          Comments only
        </label>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {layers.length === 0 && (
          <div className="px-3 py-3 text-[11px] text-[#a1847a]">
            {objects.size === 0 ? "The board is empty." : "No layers match."}
          </div>
        )}
        {layers.map((obj) => {
          const Icon = TYPE_ICON[obj.type] || MousePointer2;
          const isSel = selection.includes(obj.id);
          return (
            <div
              key={obj.id}
              className={`group flex items-center gap-1.5 px-2 py-1.5 cursor-pointer ${
                isSel ? "bg-amber-500/10" : "hover:bg-[#2a181d]"
              }`}
              onClick={() => select(obj)}
              onDoubleClick={() => locate(obj)}
            >
              <Icon size={12} className={isSel ? "text-amber-400" : "text-[#a1847a]"} />
              <span
                className={`min-w-0 flex-1 truncate text-[11px] ${isSel ? "text-[#fbeeda]" : "text-[#c3a596]"}`}
                title={label(obj)}
              >
                {label(obj)}
              </span>
              {grouped(obj) && (
                <span className="rounded bg-[#332026] px-1 text-[9px] text-[#a1847a]">grp</span>
              )}
              {obj.type === "comment" && obj.payload?.data?.resolved && (
                <span className="text-[9px] text-emerald-400/80">
                  <Eye size={10} />
                </span>
              )}
              <div className="hidden items-center gap-0.5 group-hover:flex">
                <button
                  className="p-0.5 rounded text-[#a1847a] hover:text-amber-400"
                  title="Bring to front"
                  onClick={(e) => {
                    e.stopPropagation();
                    sendToEnd(obj, true);
                  }}
                >
                  <ArrowUpToLine size={12} />
                </button>
                <button
                  className="p-0.5 rounded text-[#a1847a] hover:text-amber-400"
                  title="Send to back"
                  onClick={(e) => {
                    e.stopPropagation();
                    sendToEnd(obj, false);
                  }}
                >
                  <ArrowDownToLine size={12} />
                </button>
                <button
                  className="p-0.5 rounded text-[#a1847a] hover:text-red-400"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(obj);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-3 py-2 border-t border-[#43272e] text-[10px] text-[#a1847a]">
        {objects.size} object{objects.size === 1 ? "" : "s"} · double-click to focus
      </div>
    </aside>
  );
}
