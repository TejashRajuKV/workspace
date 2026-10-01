"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useBoard, boardRefs, sendPresence } from "@/state/board";
import { Quadtree } from "./canvas-engine/quadtree";
import { createRenderer } from "./canvas-engine/renderer";
import { createInteractions } from "./canvas-engine/tools";
import { buildHistoryEntry } from "./canvas-engine/history";
import { objectBounds, makeStyle } from "@/shared/canvasOps";
import { OP, newObjectId } from "@/shared/protocol";

// The infinite board: owns the canvas element, the render loop, the quadtree
// (incremental sync from boardRefs.changedIds) and the inline text editor.
export default function CanvasBoard() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null); // { quad, renderer, interactions }
  const [editor, setEditor] = useState(null); // { objId|null, world, value, kind }
  const editorRef = useRef(null);
  const [zoomLabel, setZoomLabel] = useState(100);

  // ---- one-time engine setup ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const quad = new Quadtree();
    const renderer = createRenderer(canvas, quad);
    engineRef.current = { quad, renderer, interactions: null };

    const resize = () => renderer.resize();
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let lastObjectsSize = -1;
    let lastSig = "";
    const loop = () => {
      const s = useBoard.getState();

      // incremental quadtree sync
      if (boardRefs.fullRebuild) {
        boardRefs.fullRebuild = false;
        quad.clear();
        for (const [id, obj] of s.objects) quad.insert(id, objectBounds(obj));
        renderer.markDirty(); // joined/bootstrap objects must appear
      } else if (boardRefs.changedIds.size) {
        for (const id of boardRefs.changedIds) {
          const obj = s.objects.get(id);
          if (obj) quad.update(id, objectBounds(obj));
          else quad.remove(id);
        }
        boardRefs.changedIds.clear();
        renderer.markDirty(); // remote + local ops change what is drawn
      }

      // repaint on camera moves and presence/selection ticks — the renderer
      // skips frames while "clean", so without this pan/zoom and remote
      // cursors would leave the canvas frozen until the next local drag
      const sig = `${s.camera.x}|${s.camera.y}|${s.camera.zoom}|${boardRefs.renderTick}|${s.selection.join(",")}`;
      if (sig !== lastSig) {
        lastSig = sig;
        renderer.markDirty();
      }

      const preview = engineRef.current.interactions?.getPreview?.() || null;
      renderer.render(s.camera, s.objects, {
        selection: s.selection,
        cursors: boardRefs.cursors,
        remoteSelections: boardRefs.remoteSelections,
        marquee: boardRefs.marquee,
        preview,
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // camera zoom label (cheap: poll at 4Hz)
    const zTimer = setInterval(() => {
      const z = useBoard.getState().camera.zoom;
      setZoomLabel(Math.round(z * 100));
    }, 250);

    const interactions = createInteractions(canvas, {
      quad,
      renderer,
      onEditObject: ({ objId, kind }) => {
        const obj = useBoard.getState().objects.get(objId);
        if (!obj) return;
        setEditor({ objId, kind, world: null, value: obj.payload.data?.text || "" });
      },
      onNewText: ({ x, y }) => {
        setEditor({ objId: null, kind: "text", world: { x, y }, value: "" });
      },
    });
    engineRef.current.interactions = interactions;

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      clearInterval(zTimer);
      interactions.destroy();
    };
  }, []);

  // position the inline editor overlay (imperative — no ref access during
  // render, no setState in effect)
  const textareaRef = useRef(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!editor) {
      el.style.display = "none";
      return;
    }
    const s = useBoard.getState();
    let wx, wy, w, h, fontSize;
    if (editor.objId) {
      const obj = s.objects.get(editor.objId);
      if (!obj) {
        el.style.display = "none";
        return;
      }
      const p = obj.payload;
      wx = p.x;
      wy = p.y;
      w = p.w;
      fontSize = p.style?.fontSize || (editor.kind === "sticky" ? 14 : 16);
      h = Math.max(p.h, 24);
    } else {
      wx = editor.world.x;
      wy = editor.world.y;
      w = 260;
      fontSize = s.style.fontSize || 16;
      h = 40;
    }
    const rect = canvasRef.current.getBoundingClientRect();
    el.style.display = "block";
    el.style.left = `${rect.left + (wx - s.camera.x) * s.camera.zoom}px`;
    el.style.top = `${rect.top + (wy - s.camera.y) * s.camera.zoom}px`;
    el.style.width = `${Math.max(w * s.camera.zoom, 40)}px`;
    el.style.height = `${Math.max(h * s.camera.zoom, 28)}px`;
    el.style.fontSize = `${fontSize * s.camera.zoom}px`;
  }, [editor]);

  const commitEditor = (commit) => {
    const e = editor;
    if (!e) return;
    setEditor(null);
    if (!commit) return;
    const s = useBoard.getState();
    const text = editorRef.current?.value ?? e.value;
    if (e.objId) {
      const obj = s.objects.get(e.objId);
      if (obj && obj.payload.data?.text !== text) {
        const op = { type: OP.TEXT, oid: e.objId, p: { text } };
        const entry = buildHistoryEntry(s.objects, op); // captures old text
        s.submitOps([op], entry ? [entry] : undefined);
      }
    } else {
      const id = newObjectId();
      let max = 0;
      for (const o of s.objects.values()) if ((o.z || 0) > max) max = o.z || 0;
      const payload = {
        x: e.world.x,
        y: e.world.y,
        w: 260,
        h: Math.max(30, (text.split("\n").length || 1) * (s.style.fontSize || 16) * 1.4),
        rot: 0,
        style: makeStyle({ ...s.style, fill: "transparent", align: "left" }),
        data: { text },
      };
      const op = { type: OP.CREATE, oid: id, p: { object: { id, type: "text", payload, z: max + 1 } } };
      const entry = buildHistoryEntry(s.objects, op);
      s.submitOps([op], [entry]);
    }
  };

  return (
    <div className="relative flex-1 min-w-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full touch-none"
        style={{ background: "#f7f8fb" }}
      />
      {editor && (
        <textarea
          ref={(el) => {
            textareaRef.current = el;
            editorRef.current = el;
          }}
          autoFocus
          defaultValue={editor.value}
          className="absolute z-30 rounded-md border-2 resize-none overflow-hidden p-2 leading-snug outline-none bg-white text-slate-900 shadow-lg"
          style={{ position: "fixed", display: "none" }}
          placeholder="Type text…"
          onKeyDown={(ev) => {
            if (ev.key === "Escape") commitEditor(false);
            if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) commitEditor(true);
            ev.stopPropagation();
          }}
          onBlur={() => commitEditor(true)}
        />
      )}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg bg-white/90 shadow px-1.5 py-1 text-xs text-slate-600 border border-slate-200 select-none">
        <button
          className="px-1.5 hover:bg-slate-100 rounded"
          onClick={() => {
            const s = useBoard.getState();
            const canvas = canvasRef.current;
            s.setCamera(zoomCam(s.camera, canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.2));
          }}
        >
          −
        </button>
        <span className="w-10 text-center font-medium">{zoomLabel}%</span>
        <button
          className="px-1.5 hover:bg-slate-100 rounded"
          onClick={() => {
            const s = useBoard.getState();
            const canvas = canvasRef.current;
            s.setCamera(zoomCam(s.camera, canvas.clientWidth / 2, canvas.clientHeight / 2, 1.2));
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}

function zoomCam(cam, sx, sy, factor) {
  const zoom = Math.min(8, Math.max(0.02, cam.zoom * factor));
  const wx = sx / cam.zoom + cam.x;
  const wy = sy / cam.zoom + cam.y;
  return { zoom, x: wx - sx / zoom, y: wy - sy / zoom };
}
