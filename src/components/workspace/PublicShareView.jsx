"use client";

// Public, read-only view for `/?s=<token>` share links. No session, no socket,
// no edits — just the board snapshot plus a file browser.

import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import { Eye, FileCode2, Loader2, Lock, Maximize2 } from "lucide-react";
import { Quadtree } from "./canvas-engine/quadtree";
import { createRenderer } from "./canvas-engine/renderer";
import { zoomCameraAt } from "./canvas-engine/camera";
import { objectBounds } from "@/shared/canvasOps";
import { defineIwTheme } from "@/lib/monacoTheme";
import { languageOf } from "@/lib/language";
import { InfiniteBoard } from "./InfiniteBoardLogo";

loader.config({ paths: { vs: "/monaco/vs" } });

const SHARE_ASSET = /^\/api\/workspaces\/[\w-]+\/assets\/([\w-]+)$/;

export default function PublicShareView({ token }) {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("board");
  const [activeFile, setActiveFile] = useState("");
  const canvasRef = useRef(null);
  const engineRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/share/${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!alive) return;
        setSnap(data);
        setActiveFile(data.files?.[0]?.path || "");
      } catch (err) {
        if (alive) setError(err.message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  // ---- read-only board rendering (pan + zoom, no editing) ----
  useEffect(() => {
    if (!snap || tab !== "board") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const objects = new Map();
    for (const o of snap.canvas || []) {
      const payload = { ...(o.payload || {}) };
      const data = { ...(payload.data || {}) };
      const m = typeof data.src === "string" && data.src.match(SHARE_ASSET);
      if (m) data.src = `/api/share/${encodeURIComponent(token)}/assets/${m[1]}`;
      payload.data = data;
      objects.set(o.id, { id: o.id, type: o.type, z: o.z, payload });
    }

    const quad = new Quadtree();
    for (const [id, obj] of objects) quad.insert(id, objectBounds(obj));
    const renderer = createRenderer(canvas, quad);
    renderer.resize();
    engineRef.current = { renderer, quad, camera: null };

    // fit content into view on load
    const zoom = fitCameraToObjects(canvas, objects);
    const cam = { x: zoom.x, y: zoom.y, zoom: zoom.zoom };

    let raf = 0;
    const draw = () => {
      renderer.markDirty();
      renderer.render(cam, objects, { selection: [] });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const onResize = () => renderer.resize();
    window.addEventListener("resize", onResize);

    // pan / zoom
    let dragging = false;
    let last = null;
    const down = (e) => {
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = "grabbing";
    };
    const move = (e) => {
      if (!dragging) return;
      cam.x -= (e.clientX - last.x) / cam.zoom;
      cam.y -= (e.clientY - last.y) / cam.zoom;
      last = { x: e.clientX, y: e.clientY };
    };
    const up = () => {
      dragging = false;
      canvas.style.cursor = "grab";
    };
    const wheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      Object.assign(cam, zoomCameraAt(cam, e.clientX - rect.left, e.clientY - rect.top, factor));
    };
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    canvas.addEventListener("wheel", wheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [snap, tab, token]);

  const active = snap?.files?.find((f) => f.path === activeFile) || null;
  const folders = (snap?.folders || []).filter(Boolean);

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-[#170d12] text-[#c3a596] text-sm">
        <Lock size={26} className="text-[#a1847a]" />
        <p className="text-[#fbeeda] font-medium">This link is unavailable</p>
        <p className="text-xs">{error}</p>
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="min-h-screen flex items-center justify-center gap-2 bg-[#170d12] text-[#c3a596] text-sm">
        <Loader2 size={16} className="animate-spin" /> Loading shared workspace…
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-[#170d12] text-[#fbeeda]">
      <header className="flex h-14 flex-none items-center gap-3 border-b border-[#43272e] px-4">
        <InfiniteBoard size={22} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{snap.workspace.name}</div>
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-[#a1847a]">
            <Eye size={10} /> Read-only shared view
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1 rounded-lg border border-[#43272e] p-0.5">
          <button
            className={`btn px-2.5 py-1 text-xs ${tab === "board" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setTab("board")}
          >
            <Maximize2 size={12} /> Board
          </button>
          <button
            className={`btn px-2.5 py-1 text-xs ${tab === "files" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setTab("files")}
          >
            <FileCode2 size={12} /> Files ({snap.files?.length || 0})
          </button>
        </div>
      </header>

      {tab === "board" ? (
        <div className="relative flex-1">
          <canvas ref={canvasRef} className="h-full w-full touch-none" />
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-[#201317]/85 px-2.5 py-1 text-[10px] text-[#a1847a] border border-[#43272e]">
            Drag to pan · scroll to zoom
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-60 flex-none overflow-y-auto border-r border-[#43272e] p-2">
            {folders.map((f) => (
              <div key={f} className="px-2 py-1 text-[11px] font-medium text-[#a1847a]">
                {f}
              </div>
            ))}
            {(snap.files || []).map((f) => (
              <button
                key={f.path}
                onClick={() => setActiveFile(f.path)}
                className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${
                  activeFile === f.path ? "bg-[#332026] text-[#fbeeda]" : "text-[#c3a596] hover:bg-[#2a181d]"
                }`}
                title={f.path}
              >
                {f.path}
              </button>
            ))}
          </aside>
          <div className="min-w-0 flex-1">
            {active ? (
              <Editor
                height="100%"
                theme="iw-dark"
                beforeMount={defineIwTheme}
                language={languageOf(active.path)}
                value={active.content}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  domReadOnly: true,
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-[#a1847a]">
                No files to show
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Fit all objects inside the viewport with a little padding.
function fitCameraToObjects(canvas, objects) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const obj of objects.values()) {
    const b = objectBounds(obj);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const w = canvas.clientWidth || 800;
  const h = canvas.clientHeight || 600;
  if (!Number.isFinite(minX)) return { x: -w / 2, y: -h / 2, zoom: 1 };
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const zoom = Math.max(0.1, Math.min(1.5, Math.min((w - 80) / bw, (h - 80) / bh)));
  return {
    x: (minX + maxX) / 2 - w / 2 / zoom,
    y: (minY + maxY) / 2 - h / 2 / zoom,
    zoom,
  };
}
