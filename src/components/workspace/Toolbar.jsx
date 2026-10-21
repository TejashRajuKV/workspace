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
  MessageSquarePlus,
  Frame,
  Group as GroupIcon,
  Ungroup,
  Undo2,
  Redo2,
  Trash2,
  Copy,
  ChevronUp,
  ChevronDown,
  Palette,
  AlignLeft,
  AlignCenter,
  AlignRight,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  { id: "comment", icon: MessageSquarePlus, label: "Comment (M)" },
  { id: "frame", icon: Frame, label: "Frame (F)" },
  { id: "eraser", icon: Eraser, label: "Eraser (E)" },
];

const FILL_COLORS = [
  "transparent",
  "#ffffff",
  "#f1f5f9",
  "#f6ddc0",
  "#94a3b8",
  "#fecaca",
  "#fca5a5",
  "#fed7aa",
  "#fdba74",
  "#fef08a",
  "#fde047",
  "#bbf7d0",
  "#86efac",
  "#a7f3d0",
  "#bae6fd",
  "#7dd3fc",
  "#c7d2fe",
  "#c4b5fd",
  "#fbcfe8",
  "#f9a8d4",
];

const STROKE_COLORS = [
  "#111827",
  "#334155",
  "#64748b",
  "#94a3b8",
  "#ffffff",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#22c55e",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#d946ef",
  "#ec4899",
];

const WIDTH_PRESETS = [1, 2, 4, 8, 14];

const RAINBOW =
  "conic-gradient(from 0deg, #ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)";

export default function Toolbar() {
  const tool = useBoard((s) => s.tool);
  const style = useBoard((s) => s.style);
  const setTool = useBoard((s) => s.setTool);
  const setStyle = useBoard((s) => s.setStyle);
  const undo = useBoard((s) => s.undo);
  const redo = useBoard((s) => s.redo);
  const undoCount = useBoard((s) => s.history.undo.length);
  const redoCount = useBoard((s) => s.history.redo.length);
  const selection = useBoard((s) => s.selection);
  const role = useBoard((s) => s.role);
  const fileRef = useRef(null);
  const [showPalette, setShowPalette] = useState(false);
  const canEdit = role !== "viewer";
  const hasSelection = selection.length > 0 && canEdit;
  const single = selection.length === 1 ? selection[0] : null;

  // Mirror the selected object's style in the bar so tweaking it is immediate.
  useEffect(() => {
    if (!single) return;
    const obj = useBoard.getState().objects.get(single);
    if (obj?.payload?.style) {
      setStyle({ ...useBoard.getState().style, ...obj.payload.style });
    }
  }, [single, setStyle]);

  const submitStyleToSelection = (patch) => {
    const s = useBoard.getState();
    const ops = [];
    const entries = [];
    for (const id of s.selection) {
      const obj = s.objects.get(id);
      if (!obj) continue;
      const op = { type: OP.STYLE, oid: id, p: { style: patch } };
      const entry = buildHistoryEntry(s.objects, op);
      if (entry) {
        ops.push(op);
        entries.push(entry);
      }
    }
    if (ops.length) s.submitOps(ops, entries);
  };

  const applyStyle = (patch) => {
    setStyle(patch);
    if (hasSelection) submitStyleToSelection(patch);
  };

  const deleteSelection = () => {
    const s = useBoard.getState();
    const ops = [];
    const entries = [];
    for (const id of s.selection) {
      const op = { type: OP.DELETE, oid: id, p: {} };
      const entry = buildHistoryEntry(s.objects, op);
      if (entry) {
        ops.push(op);
        entries.push(entry);
      }
    }
    if (ops.length) s.submitOps(ops, entries);
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

  const groupSelection = () => {
    const s = useBoard.getState();
    if (s.role === "viewer" || s.selection.length < 2) return;
    const gid = "g_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ops = [];
    const entries = [];
    for (const id of s.selection) {
      const op = { type: OP.GROUP, oid: id, p: { groupId: gid } };
      const entry = buildHistoryEntry(s.objects, op);
      ops.push(op);
      if (entry) entries.push(entry);
    }
    s.submitOps(ops, entries);
  };

  const ungroupSelection = () => {
    const s = useBoard.getState();
    if (s.role === "viewer") return;
    const gids = new Set();
    for (const id of s.selection) {
      const g = s.objects.get(id)?.payload?.groupId;
      if (g) gids.add(g);
    }
    if (!gids.size) return;
    const ops = [];
    const entries = [];
    for (const o of s.objects.values()) {
      if (o.payload?.groupId && gids.has(o.payload.groupId)) {
        const op = { type: OP.GROUP, oid: o.id, p: { groupId: "" } };
        const entry = buildHistoryEntry(s.objects, op);
        ops.push(op);
        if (entry) entries.push(entry);
      }
    }
    if (ops.length) s.submitOps(ops, entries);
  };

  const layer = (dir) => {    const s = useBoard.getState();
    const ops = [];
    const entries = [];
    for (const id of s.selection) {
      const obj = s.objects.get(id);
      if (!obj) continue;
      const z = dir === "front" ? nextZ(s) : minZ(s) - 1;
      const op = { type: OP.ZORDER, oid: id, p: { z } };
      const entry = buildHistoryEntry(s.objects, op);
      if (entry) {
        ops.push(op);
        entries.push(entry);
      }
    }
    if (ops.length) s.submitOps(ops, entries);
  };

  const onImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("Only image files can be inserted", "error");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast("Image too large (max 8 MB)", "error");
      return;
    }
    const s = useBoard.getState();
    if (s.role === "viewer") return;
    if (!s.wsId) {
      toast("Open a workspace before inserting images", "error");
      return;
    }
    // Upload to disk (asset rows) instead of inlining a data URL, so big
    // boards stay small and the op payload stays tiny.
    let url;
    try {
      const res = await fetch(`/api/workspaces/${s.wsId}/assets`, {
        method: "POST",
        headers: { "content-type": file.type, "x-filename": encodeURIComponent(file.name || "image") },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.asset?.url) throw new Error(data.error || "Upload failed");
      url = data.asset.url;
    } catch (err) {
      toast(String(err.message || err), "error");
      return;
    }
    const img = new Image();
    img.onload = () => {
      const cur = useBoard.getState();
      const scale = Math.min(1, 420 / Math.max(img.width, img.height));
      const id = newObjectId();
      const cam = cur.camera;
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
        data: { src: url },
      };
      const op = { type: OP.CREATE, oid: id, p: { object: { id, type: "image", payload, z: nextZ(cur) } } };
      const entry = buildHistoryEntry(cur.objects, op);
      cur.submitOps([op], [entry]);
    };
    img.onerror = () => toast("Could not read that image", "error");
    img.src = url;
  };

  return (
    <>
      {/* tool rail — anchored inside the board area (not vertically centered:
          with 13 buttons it is taller than short viewports and would spill
          over the top bar and terminal) */}
      <div className="absolute left-3 top-3 bottom-3 z-20 flex flex-col gap-0.5 rounded-xl bg-[#fff7ec] shadow-xl border border-[#e8d0b8] p-1 overflow-y-auto">
        {TOOLS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            title={label}
            disabled={!canEdit && id !== "select" && id !== "hand"}
            onClick={() => setTool(id)}
            className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
              tool === id ? "bg-amber-500 text-[#2a1208]" : "text-[#6b4a44] hover:bg-[#f6e3d2]"
            } disabled:opacity-40`}
          >
            <Icon size={17} />
          </button>
        ))}
        <div className="h-px bg-[#e8d0b8] mx-1 my-0.5" />
        <button
          title="Insert image"
          disabled={!canEdit}
          onClick={() => fileRef.current?.click()}
          className="w-9 h-9 flex items-center justify-center rounded-lg text-[#6b4a44] hover:bg-[#f6e3d2] disabled:opacity-40"
        >
          <ImageIcon size={17} />
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onImage} />
      </div>

      {/* style bar */}
      <div className="absolute top-3 left-[4.25rem] right-3 z-20 flex justify-center pointer-events-none">
        <div className="pointer-events-auto relative flex flex-wrap items-center justify-center gap-1 rounded-xl bg-[#fff7ec] shadow-xl border border-[#e8d0b8] px-2 py-1.5 [&>*]:flex-none max-w-full">
          <button title="Undo (Ctrl+Z)" disabled={!canEdit || !undoCount} onClick={undo} className="w-8 h-8 flex items-center justify-center rounded-lg text-[#6b4a44] hover:bg-[#f6e3d2] disabled:opacity-30">
            <Undo2 size={16} />
          </button>
          <button title="Redo (Ctrl+Shift+Z)" disabled={!canEdit || !redoCount} onClick={redo} className="w-8 h-8 flex items-center justify-center rounded-lg text-[#6b4a44] hover:bg-[#f6e3d2] disabled:opacity-30">
            <Redo2 size={16} />
          </button>
          <div className="w-px h-6 bg-[#e8d0b8] mx-1" />

          {/* current fill / stroke + any-colour pickers */}
          <span className="max-md:hidden text-[10px] uppercase tracking-wide text-[#a1847a]">Fill</span>
          <button
            type="button"
            title={style.fill === "transparent" ? "No fill" : `Fill ${style.fill}`}
            disabled={!canEdit}
            onClick={() => applyStyle({ fill: style.fill === "transparent" ? "#f6ddc0" : "transparent" })}
            className={`w-6 h-6 rounded-md border-2 ${style.fill === "transparent" ? "checker" : ""} ${style.fill === "transparent" ? "border-[#e8d0b8]" : "border-[#d9bfa5]"} disabled:opacity-40`}
            style={style.fill === "transparent" ? undefined : { background: style.fill }}
          />
          <label title="Pick any fill colour" className="relative w-6 h-6 rounded-md border-2 border-[#e8d0b8] cursor-pointer overflow-hidden" style={{ background: RAINBOW }}>
            <input
              type="color"
              value={style.fill === "transparent" ? "#ffffff" : style.fill}
              disabled={!canEdit}
              onChange={(e) => applyStyle({ fill: e.target.value })}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </label>

          <span className="max-md:hidden text-[10px] uppercase tracking-wide text-[#a1847a] ml-1">Line</span>
          <button
            type="button"
            title={`Line ${style.stroke}`}
            disabled={!canEdit}
            onClick={() => applyStyle({ stroke: style.stroke === "#6b4a44" ? "#e76f51" : "#6b4a44" })}
            className="w-6 h-6 rounded-full border-2 border-[#d9bfa5] disabled:opacity-40"
            style={{ background: style.stroke }}
          />
          <label title="Pick any line colour" className="relative w-6 h-6 rounded-full border-2 border-[#e8d0b8] cursor-pointer overflow-hidden" style={{ background: RAINBOW }}>
            <input
              type="color"
              value={style.stroke}
              disabled={!canEdit}
              onChange={(e) => applyStyle({ stroke: e.target.value })}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </label>

          <span className="max-md:hidden text-[10px] uppercase tracking-wide text-[#a1847a] ml-1">Text</span>
          <label
            title="Text colour"
            className="relative w-6 h-6 rounded-md border-2 border-[#d9bfa5] cursor-pointer overflow-hidden flex items-center justify-center bg-[#fff7ec] font-bold text-[12px]"
            style={{ color: style.color }}
          >
            A
            <input
              type="color"
              value={style.color}
              disabled={!canEdit}
              onChange={(e) => applyStyle({ color: e.target.value })}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </label>
          <button
            title="More colours"
            disabled={!canEdit}
            onClick={() => setShowPalette((v) => !v)}
            className={`w-8 h-8 flex items-center justify-center rounded-lg ${showPalette ? "bg-amber-50 text-amber-600" : "text-[#6b4a44] hover:bg-[#f6e3d2]"} disabled:opacity-30`}
          >
            <Palette size={16} />
          </button>

          <div className="w-px h-6 bg-[#e8d0b8] mx-1" />

          {/* stroke width */}
          <span className="text-[10px] uppercase tracking-wide text-[#a1847a]">W</span>
          {WIDTH_PRESETS.map((w) => (
            <button
              key={w}
              title={`Stroke ${w}px`}
              disabled={!canEdit}
              onClick={() => applyStyle({ strokeWidth: w })}
              className={`w-7 h-7 flex items-center justify-center rounded-md hover:bg-[#f6e3d2] disabled:opacity-40 ${
                (style.strokeWidth || 2) === w ? "bg-[#f6e3d2] ring-1 ring-amber-400" : ""
              }`}
            >
              <span className="block rounded-full bg-stone-700" style={{ width: Math.min(w + 3, 14), height: Math.max(1, Math.min(w, 8)) }} />
            </button>
          ))}
          <input
            type="range"
            min="1"
            max="40"
            value={style.strokeWidth || 2}
            disabled={!canEdit}
            onChange={(e) => setStyle({ strokeWidth: Number(e.target.value) })}
            onPointerUp={(e) => hasSelection && submitStyleToSelection({ strokeWidth: Number(e.target.value) })}
            onKeyUp={(e) => hasSelection && submitStyleToSelection({ strokeWidth: Number(e.target.value) })}
            className="max-md:hidden w-14 accent-amber-500"
            title="Stroke width"
          />

          <div className="max-md:hidden flex items-center gap-1">
            <div className="w-px h-6 bg-[#e8d0b8] mx-1" />
            <span className="text-[10px] uppercase tracking-wide text-[#a1847a]">Op</span>
            <input
              type="range"
              min="5"
              max="100"
              value={Math.round((style.opacity ?? 1) * 100)}
              disabled={!canEdit}
              onChange={(e) => setStyle({ opacity: Number(e.target.value) / 100 })}
              onPointerUp={(e) => hasSelection && submitStyleToSelection({ opacity: Number(e.target.value) / 100 })}
              onKeyUp={(e) => hasSelection && submitStyleToSelection({ opacity: Number(e.target.value) / 100 })}
              className="w-14 accent-amber-500"
              title="Opacity"
            />
            <span className="text-[10px] text-[#a1847a] w-7 text-right">{Math.round((style.opacity ?? 1) * 100)}%</span>
          </div>

          {/* dash */}
          <button
            title="Dashed line"
            disabled={!canEdit}
            onClick={() => applyStyle({ dash: style.dash ? 0 : 8 })}
            className={`w-8 h-8 flex items-center justify-center rounded-lg disabled:opacity-30 ${
              style.dash ? "bg-amber-50 text-amber-600" : "text-[#6b4a44] hover:bg-[#f6e3d2]"
            }`}
          >
            <span className="w-4 border-t-2 border-dashed border-current" />
          </button>

          {/* corner radius */}
          <label className="max-md:hidden flex items-center gap-1 text-[11px] text-stone-500" title="Corner radius">
            <span>R</span>
            <input
              type="number"
              min="0"
              max="80"
              value={style.cornerRadius ?? 3}
              disabled={!canEdit}
              onChange={(e) => setStyle({ cornerRadius: Number(e.target.value) || 0 })}
              onBlur={(e) => hasSelection && submitStyleToSelection({ cornerRadius: Number(e.target.value) || 0 })}
              className="w-10 border border-[#e8d0b8] rounded px-1 py-0.5"
            />
          </label>

          {/* font size */}
          <label className="max-md:hidden flex items-center gap-1 text-[11px] text-stone-500" title="Font size">
            <span>px</span>
            <input
              type="number"
              min="6"
              max="200"
              value={style.fontSize || 16}
              disabled={!canEdit}
              onChange={(e) => setStyle({ fontSize: Number(e.target.value) || 16 })}
              onBlur={(e) => hasSelection && submitStyleToSelection({ fontSize: Number(e.target.value) || 16 })}
              className="w-14 border border-[#e8d0b8] rounded px-1 py-0.5"
            />
          </label>

          {/* text alignment */}
          <div className="max-md:hidden flex items-center gap-0.5">
            {[
              ["left", AlignLeft],
              ["center", AlignCenter],
              ["right", AlignRight],
            ].map(([a, Icon]) => (
              <button
                key={a}
                title={`Align ${a}`}
                disabled={!canEdit}
                onClick={() => applyStyle({ align: a })}
                className={`w-7 h-7 flex items-center justify-center rounded-md disabled:opacity-30 ${
                  (style.align || "center") === a ? "bg-amber-50 text-amber-600" : "text-[#6b4a44] hover:bg-[#f6e3d2]"
                }`}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>

          <div className="w-px h-6 bg-[#e8d0b8] mx-1" />
          <button title="Bring to front" disabled={!hasSelection} onClick={() => layer("front")} className="max-md:hidden w-8 h-8 flex items-center justify-center rounded-lg text-[#6b4a44] hover:bg-[#f6e3d2] disabled:opacity-30">
            <ChevronUp size={16} />
          </button>
          <button title="Send to back" disabled={!hasSelection} onClick={() => layer("back")} className="max-md:hidden w-8 h-8 flex items-center justify-center rounded-lg text-[#6b4a44] hover:bg-[#f6e3d2] disabled:opacity-30">
            <ChevronDown size={16} />
          </button>
          <button title="Duplicate (Ctrl+D)" disabled={!hasSelection} onClick={duplicateSelection} className="w-8 h-8 flex items-center justify-center rounded-lg text-[#6b4a44] hover:bg-[#f6e3d2] disabled:opacity-30">
            <Copy size={16} />
          </button>
          <button
            title="Group (Ctrl+G)"
            disabled={selection.length < 2 || !canEdit}
            onClick={groupSelection}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[#6b4a44] hover:bg-[#f6e3d2] disabled:opacity-30"
          >
            <GroupIcon size={16} />
          </button>
          <button
            title="Ungroup (Ctrl+Shift+G)"
            disabled={!selection.some((id) => useBoard.getState().objects.get(id)?.payload?.groupId) || !canEdit}
            onClick={ungroupSelection}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[#6b4a44] hover:bg-[#f6e3d2] disabled:opacity-30"
          >
            <Ungroup size={16} />
          </button>
          <button title="Delete (Del)" disabled={!hasSelection} onClick={deleteSelection} className="w-8 h-8 flex items-center justify-center rounded-lg text-red-500 hover:bg-red-50 disabled:opacity-30">
            <Trash2 size={16} />
          </button>

          {/* expanded palette */}
          {showPalette && (
            <div className="absolute top-full left-0 mt-2 z-30 rounded-xl border border-[#e8d0b8] bg-[#fff7ec] shadow-2xl p-3 w-[19rem]">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[#a1847a] mb-1.5">Fill</div>
              <div className="grid grid-cols-10 gap-1.5 mb-3">
                {FILL_COLORS.map((c) => (
                  <button
                    key={c}
                    title={c === "transparent" ? "No fill" : c}
                    disabled={!canEdit}
                    onClick={() => applyStyle({ fill: c })}
                    className={`w-5 h-5 rounded-md border-2 ${style.fill === c ? "border-amber-500" : "border-[#e8d0b8]"} ${c === "transparent" ? "checker" : ""} disabled:opacity-40`}
                    style={c === "transparent" ? undefined : { background: c }}
                  />
                ))}
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[#a1847a] mb-1.5">Line</div>
              <div className="grid grid-cols-10 gap-1.5">
                {STROKE_COLORS.map((c) => (
                  <button
                    key={c}
                    title={c}
                    disabled={!canEdit}
                    onClick={() => applyStyle({ stroke: c })}
                    className={`w-5 h-5 rounded-full border-2 ${style.stroke === c ? "border-amber-500" : "border-[#e8d0b8]"} disabled:opacity-40`}
                    style={{ background: c }}
                  />
                ))}
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[#a1847a] mb-1.5 mt-3">Text</div>
              <div className="grid grid-cols-10 gap-1.5">
                {STROKE_COLORS.map((c) => (
                  <button
                    key={c}
                    title={c}
                    disabled={!canEdit}
                    onClick={() => applyStyle({ color: c })}
                    className={`w-5 h-5 rounded-md border-2 ${style.color === c ? "border-amber-500" : "border-[#e8d0b8]"} disabled:opacity-40`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          )}
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
