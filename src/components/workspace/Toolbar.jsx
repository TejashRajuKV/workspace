"use client";

// Board tool rail + floating style bar.

import {
  MousePointer2,
  Hand,
  Square,
  Circle,
  Minus,
  MoveUpRight,
  Pencil,
  Type,
  StickyNote,
  GitBranch,
  Eraser,
  Image as ImageIcon,
  Undo2,
  Redo2,
  Trash2,
  Copy,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { useRef } from "react";
import { useBoard } from "@/state/board";
import { toast } from "./Feedback";
import { OP, newObjectId } from "@/shared/protocol";
import { makeStyle } from "@/shared/canvasOps";
import { buildHistoryEntry } from "./canvas-engine/history";

const TOOLS = [
  { id: "select", icon: MousePointer2, label: "Select (V)" },
  { id: "hand", icon: Hand, label: "Pan (H)" },
  { id: "rectangle", icon: Square, label: "Rectangle (R)" },
  { id: "ellipse", icon: Circle, label: "Ellipse (O)" },
  { id: "line", icon: Minus, label: "Line (L)" },
  { id: "arrow", icon: MoveUpRight, label: "Arrow (A)" },
  { id: "freehand", icon: Pencil, label: "Draw (P)" },
  { id: "text", icon: Type, label: "Text (T)" },
  { id: "sticky", icon: StickyNote, label: "Sticky note (N)" },
  { id: "connector", icon: GitBranch, label: "Connector (C)" },
  { id: "eraser", icon: Eraser, label: "Eraser (E)" },
];

const FILL_COLORS = ["transparent", "#dbe4f0", "#fde047", "#86efac", "#7dd3fc", "#f9a8d4", "#c4b5fd", "#fdba74"];
const STROKE_COLORS = ["#31405c", "#10b981", "#ef4444", "#f59e0b", "#06b6d4", "#8b5cf6", "#ec4899", "#111827"];

export default function Toolbar() {
  const tool = useBoard((s) => s.tool);
  const style = useBoard((s) => s.style);
  const setTool = useBoard((s) => s.setTool);
  const setStyle = useBoard((s) => s.setStyle);
  const undo = useBoard((s) => s.undo);
  const redo = useBoard((s) => s.redo);
  const historyTick = useBoard((s) => s.historyTick);
  const selection = useBoard((s) => s.selection);
  const role = useBoard((s) => s.role);
  const fileRef = useRef(null);
  const canEdit = role !== "viewer";
  void historyTick;

  const submitStyleToSelection = (patch) => {
    const s = useBoard.getState();
    for (const id of s.selection) {
      const obj = s.objects.get(id);
      if (!obj) continue;
      const merged = { ...obj.payload.style, ...patch };
      const op = { type: OP.STYLE, oid: id, p: { style: patch } };
      const entry = buildHistoryEntry(s.objects, op);
      s.submitOps([op], entry ? [entry] : undefined);
    }
  };

  const deleteSelection = () => {
    const s = useBoard.getState();
    for (const id of s.selection) {
      const op = { type: OP.DELETE, oid: id, p: {} };
      const entry = buildHistoryEntry(s.objects, op);
      s.submitOps([op], entry ? [entry] : undefined);
    }
    s.setSelection([]);
  };

  const duplicateSelection = () => {
    const s = useBoard.getState();
    const ops = [];
    const entries = [];
    for (const id of s.selection) {
      const obj = s.objects.get(id);
      if (!obj || obj.type === "connector") continue;
      const newId = newObjectId();
      const payload = JSON.parse(JSON.stringify(obj.payload));
      payload.x += 24;
      payload.y += 24;
      const op = { type: OP.CREATE, oid: newId, p: { object: { id: newId, type: obj.type, payload, z: nextZ(s) } } };
      ops.push(op);
      entries.push(buildHistoryEntry(s.objects, op));
    }
    if (ops.length) s.submitOps(ops, entries);
  };

  const layer = (dir) => {
    const s = useBoard.getState();
    for (const id of s.selection) {
      const obj = s.objects.get(id);
      if (!obj) continue;
      const op = { type: OP.ZORDER, oid: id, p: { z: nextZ(s) * (dir === "front" ? 1 : 0.5) + (dir === "back" ? 0 : 0) } };
      if (dir === "back") op.p = { z: (minZ(s) - 1) };
      const entry = buildHistoryEntry(s.objects, op);
      s.submitOps([op], entry ? [entry] : undefined);
    }
  };

  const onImage = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const s = useBoard.getState();
      if (String(reader.result).length > 600 * 1024) {
        toast("Image too large (max ~450KB after encoding)", "error");
        return;
      }
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 420 / Math.max(img.width, img.height));
        const id = newObjectId();
        const cam = s.camera;
        const canvas = document.querySelector("canvas");
        const wx = cam.x + (canvas ? canvas.clientWidth / 2 : 400) / cam.zoom;
        const wy = cam.y + (canvas ? canvas.clientHeight / 2 : 300) / cam.zoom;
        const payload = {
          x: wx - (img.width * scale) / 2,
          y: wy - (img.height * scale) / 2,
          w: Math.max(2, img.width * scale),
          h: Math.max(2, img.height * scale),
          rot: 0,
          style: makeStyle({ fill: "transparent", strokeWidth: 0 }),
          data: { src: reader.result },
        };
        const op = { type: OP.CREATE, oid: id, p: { object: { id, type: "image", payload, z: nextZ(s) } } };
        const entry = buildHistoryEntry(s.objects, op);
        s.submitOps([op], [entry]);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const hasSelection = selection.length > 0 && canEdit;

  return (
    <>
      {/* tool rail — anchored inside the board area (not vertically centered:
          with 13 buttons it is taller than short viewports and would spill
          over the top bar and terminal) */}
      <div className="absolute left-3 top-3 bottom-3 z-20 flex flex-col gap-0.5 rounded-xl bg-white shadow-xl border border-slate-200 p-1 overflow-y-auto">
        {TOOLS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            title={label}
            disabled={!canEdit && id !== "select" && id !== "hand"}
            onClick={() => setTool(id)}
            className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
              tool === id ? "bg-emerald-500 text-white" : "text-slate-600 hover:bg-slate-100"
            } disabled:opacity-40`}
          >
            <Icon size={17} />
          </button>
        ))}
        <div className="h-px bg-slate-200 mx-1 my-0.5" />
        <button
          title="Insert image"
          disabled={!canEdit}
          onClick={() => fileRef.current?.click()}
          className="w-9 h-9 flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-40"
        >
          <ImageIcon size={17} />
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onImage} />
      </div>

      {/* style bar */}
      <div className="absolute top-3 left-[4.25rem] right-3 z-20 flex justify-center pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-1 rounded-xl bg-white shadow-xl border border-slate-200 px-2 py-1.5 [&>*]:flex-none flex-nowrap md:flex-wrap overflow-x-auto md:overflow-visible justify-start md:justify-center max-w-full">
        <button title="Undo (Ctrl+Z)" disabled={!canEdit} onClick={undo} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-30">
          <Undo2 size={16} />
        </button>
        <button title="Redo (Ctrl+Shift+Z)" disabled={!canEdit} onClick={redo} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-30">
          <Redo2 size={16} />
        </button>
        <div className="w-px h-6 bg-slate-200 mx-1" />
        {FILL_COLORS.map((c) => (
          <button
            key={c}
            title={c === "transparent" ? "No fill" : `Fill ${c}`}
            disabled={!canEdit}
            onClick={() => {
              setStyle({ fill: c });
              if (hasSelection) submitStyleToSelection({ fill: c === "transparent" ? "#ffffff" : c });
            }}
            className={`w-5 h-5 flex-none rounded-md border-2 ${style.fill === c ? "border-emerald-500" : "border-slate-200"} ${
              c === "transparent" ? "checker" : ""
            } disabled:opacity-40`}
            style={c === "transparent" ? {} : { background: c }}
          />
        ))}
        <div className="w-px h-6 bg-slate-200 mx-1" />
        {STROKE_COLORS.map((c) => (
          <button
            key={c}
            title={`Stroke ${c}`}
            disabled={!canEdit}
            onClick={() => {
              setStyle({ stroke: c });
              if (hasSelection) submitStyleToSelection({ stroke: c });
            }}
            className={`w-5 h-5 flex-none rounded-full border-2 ${style.stroke === c ? "border-emerald-500" : "border-slate-200"} disabled:opacity-40`}
            style={{ background: c }}
          />
        ))}
        <div className="w-px h-6 bg-slate-200 mx-1" />
        <label className="flex items-center gap-1 text-[11px] text-slate-500" title="Stroke width">
          <input
            type="range"
            min="1"
            max="24"
            value={style.strokeWidth || 2}
            disabled={!canEdit}
            onChange={(e) => {
              setStyle({ strokeWidth: Number(e.target.value) });
            }}
            onMouseUp={(e) => hasSelection && submitStyleToSelection({ strokeWidth: Number(e.target.value) })}
            className="w-16 accent-emerald-500"
          />
        </label>
        <label className="flex items-center gap-1 text-[11px] text-slate-500" title="Font size">
          <span>px</span>
          <input
            type="number"
            min="6"
            max="200"
            value={style.fontSize || 16}
            disabled={!canEdit}
            onChange={(e) => setStyle({ fontSize: Number(e.target.value) || 16 })}
            onBlur={(e) => hasSelection && submitStyleToSelection({ fontSize: Number(e.target.value) || 16 })}
            className="w-14 border border-slate-200 rounded px-1 py-0.5"
          />
        </label>
        <div className="w-px h-6 bg-slate-200 mx-1" />
        <button title="Bring to front" disabled={!hasSelection} onClick={() => layer("front")} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-30">
          <ChevronUp size={16} />
        </button>
        <button title="Send to back" disabled={!hasSelection} onClick={() => layer("back")} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-30">
          <ChevronDown size={16} />
        </button>
        <button title="Duplicate (Ctrl+D)" disabled={!hasSelection} onClick={duplicateSelection} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-30">
          <Copy size={16} />
        </button>
        <button title="Delete (Del)" disabled={!hasSelection} onClick={deleteSelection} className="w-8 h-8 flex items-center justify-center rounded-lg text-red-500 hover:bg-red-50 disabled:opacity-30">
          <Trash2 size={16} />
        </button>
      </div>
      </div>
    </>
  );
}

function nextZ(s) {
  let max = 0;
  for (const o of s.objects.values()) if ((o.z || 0) > max) max = o.z || 0;
  return max + 1;
}
function minZ(s) {
  let min = Infinity;
  for (const o of s.objects.values()) if ((o.z || 0) < min) min = o.z || 0;
  return isFinite(min) ? min : 0;
}
