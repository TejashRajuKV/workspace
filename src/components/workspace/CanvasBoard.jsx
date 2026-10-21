"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Maximize2 } from "lucide-react";
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
    boardRefs.renderer = renderer;

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
      onOpenComment: ({ objId }) => {
        useBoard.getState().openComment(objId);
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

  // ---- presence+ : active/idle/away status (visibility + idle timer) ----
  useEffect(() => {
    let idleTimer = null;
    let awayTimer = null;
    const publish = (status) => sendPresence({ status });
    const bump = () => {
      publish("active");
      clearTimeout(idleTimer);
      clearTimeout(awayTimer);
      idleTimer = setTimeout(() => publish("idle"), 60_000);
      awayTimer = setTimeout(() => publish("away"), 5 * 60_000);
    };
    const onVis = () => {
      if (document.hidden) publish("away");
      else bump();
    };
    bump();
    window.addEventListener("pointermove", bump, { passive: true });
    window.addEventListener("keydown", bump);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearTimeout(idleTimer);
      clearTimeout(awayTimer);
      window.removeEventListener("pointermove", bump);
      window.removeEventListener("keydown", bump);
      document.removeEventListener("visibilitychange", onVis);
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
    // autoFocus fires while the element is still display:none, so focus here
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
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
        style: makeStyle({ ...s.style, fill: "transparent", align: s.style.align || "left" }),
        data: { text },
      };
      const op = { type: OP.CREATE, oid: id, p: { object: { id, type: "text", payload, z: max + 1 } } };
      const entry = buildHistoryEntry(s.objects, op);
      s.submitOps([op], [entry]);
    }
  };

  // Zoom to fit every object on the board (Canva-style "fit page").
  const fitView = () => {
    const s = useBoard.getState();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    if (!s.objects.size) {
      s.setCamera({ x: -w / 2, y: -h / 2, zoom: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const obj of s.objects.values()) {
      const b = objectBounds(obj);
      if (![b.x, b.y, b.w, b.h].every(Number.isFinite)) continue;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    if (!Number.isFinite(minX)) {
      s.setCamera({ x: -w / 2, y: -h / 2, zoom: 1 });
      return;
    }
    const pad = 80;
    const zoom = Math.max(
      0.02,
      Math.min(
        3,
        Math.min(
          (w - pad) / Math.max(maxX - minX, 1),
          (h - pad) / Math.max(maxY - minY, 1)
        )
      )
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    s.setCamera({ zoom, x: cx - w / (2 * zoom), y: cy - h / (2 * zoom) });
  };

  return (
    <div className="relative flex-1 min-w-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full touch-none"
        style={{ background: "#fff7ec" }}
      />
      {editor && (
        <textarea
          ref={(el) => {
            textareaRef.current = el;
            editorRef.current = el;
          }}
          autoFocus
          defaultValue={editor.value}
          className="absolute z-30 rounded-md border-2 resize-none overflow-hidden p-2 leading-snug outline-none bg-[#fff7ec] text-[#2a181d] shadow-lg"
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
      <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-lg bg-[#fff7ec]/95 shadow px-1.5 py-1 text-xs text-[#6b4a44] border border-[#e8d0b8] select-none">
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[#f6e3d2]"
          title="Zoom to fit everything"
          onClick={fitView}
        >
          <Maximize2 size={12} /> Fit
        </button>
        <span className="w-px h-4 bg-[#e8d0b8] mx-0.5" />
        <button
          className="px-1.5 rounded hover:bg-[#f6e3d2]"
          title="Zoom out"
          onClick={() => {
            const s = useBoard.getState();
            const canvas = canvasRef.current;
            s.setCamera(zoomCam(s.camera, canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.2));
          }}
        >
          −
        </button>
        <button
          className="w-11 text-center font-medium py-0.5 rounded hover:bg-[#f6e3d2]"
          title="Click to reset to 100%"
          onClick={() => {
            const s = useBoard.getState();
            const canvas = canvasRef.current;
            s.setCamera(zoomCam(s.camera, canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / s.camera.zoom));
          }}
        >
          {zoomLabel}%
        </button>
        <button
          className="px-1.5 rounded hover:bg-[#f6e3d2]"
          title="Zoom in"
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
