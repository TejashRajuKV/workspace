// ============================================================
// Canvas 2D renderer.
//
// Performance model:
//   - renders ONLY inside a requestAnimationFrame loop, and only when the
//     `dirty` flag is set (state change, camera change, interaction)
//   - viewport culling: the quadtree answers "which objects are visible"
//     — a 100k-object board draws the few hundred on screen
//   - presence (cursors, remote selections) lives in non-reactive buffers
//   - image decoding is cached; text wrapping is cached per object revision
// ============================================================

import { worldToScreen, screenToWorld } from "./camera";
import { objectBounds } from "@/shared/canvasOps";
import { connectorEndpoints, handlePositions, rotatePoint } from "./geometry";

const BOARD_BG = "#f7f8fb";
const GRID_DOT = "#d5dbe6";
const SELECTION = "#10b981";
const HANDLE_FILL = "#ffffff";

export function createRenderer(canvas, quad) {
  const ctx = canvas.getContext("2d");
  const imageCache = new Map(); // id → { img, src }
  const textCache = new Map(); // cacheKey → string[]
  let dpr = 1;

  function ensureImage(obj) {
    const src = obj.payload.data?.src;
    if (!src) return null;
    let entry = imageCache.get(obj.id);
    if (!entry || entry.src !== src) {
      const img = new Image();
      img.onload = () => dirty();
      img.src = src;
      entry = { img, src };
      imageCache.set(obj.id, entry);
    }
    return entry.img.complete && entry.img.naturalWidth ? entry.img : null;
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function arrowHead(x1, y1, x2, y2, size) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }

  function drawObject(obj, cam, selectedIds, remoteSelColors) {
    const p = obj.payload;
    const st = p.style || {};
    const zoom = cam.zoom;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;

    ctx.save();
    ctx.globalAlpha = st.opacity != null ? st.opacity : 1;
    if (p.rot) {
      ctx.translate(cx, cy);
      ctx.rotate(p.rot);
      ctx.translate(-cx, -cy);
    }

    const fill = st.fill || "transparent";
    const stroke = st.stroke || "#31405c";
    const sw = (st.strokeWidth != null ? st.strokeWidth : 2);

    switch (obj.type) {
      case "rectangle":
        roundRect(p.x, p.y, p.w, p.h, 3);
        if (fill !== "transparent") {
          ctx.fillStyle = fill;
          ctx.fill();
        }
        ctx.strokeStyle = stroke;
        ctx.lineWidth = sw;
        ctx.stroke();
        break;
      case "ellipse":
        ctx.beginPath();
        ctx.ellipse(cx, cy, p.w / 2, p.h / 2, 0, 0, Math.PI * 2);
        if (fill !== "transparent") {
          ctx.fillStyle = fill;
          ctx.fill();
        }
        ctx.strokeStyle = stroke;
        ctx.lineWidth = sw;
        ctx.stroke();
        break;
      case "line": {
        const x2 = p.data?.x2 ?? p.x + p.w;
        const y2 = p.data?.y2 ?? p.y + p.h;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = sw;
        ctx.lineCap = "round";
        ctx.stroke();
        break;
      }
      case "arrow": {
        const x2 = p.data?.x2 ?? p.x + p.w;
        const y2 = p.data?.y2 ?? p.y + p.h;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = sw;
        ctx.lineCap = "round";
        ctx.stroke();
        arrowHead(p.x, p.y, x2, y2, Math.max(8, sw * 4));
        break;
      }
      case "freehand": {
        const pts = p.data?.points || [];
        if (pts.length) {
          ctx.beginPath();
          ctx.moveTo(p.x + pts[0][0], p.y + pts[0][1]);
          for (let i = 1; i < pts.length - 1; i++) {
            const mx = p.x + (pts[i][0] + pts[i + 1][0]) / 2;
            const my = p.y + (pts[i][1] + pts[i + 1][1]) / 2;
            ctx.quadraticCurveTo(p.x + pts[i][0], p.y + pts[i][1], mx, my);
          }
          const last = pts[pts.length - 1];
          ctx.lineTo(p.x + last[0], p.y + last[1]);
          ctx.strokeStyle = st.stroke || "#1c2433";
          ctx.lineWidth = sw;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.stroke();
        }
        break;
      }
      case "text": {
        ctx.fillStyle = st.color || "#1c2433";
        ctx.font = `${st.fontSize || 16}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = st.align || "left";
        ctx.textBaseline = "top";
        const tx = st.align === "center" ? cx : st.align === "right" ? p.x + p.w : p.x;
        const lines = wrapLines(String(p.data?.text || ""), p.w, st.align || "left");
        lines.forEach((line, i) => ctx.fillText(line, tx, p.y + 4 + i * (st.fontSize || 16) * 1.35));
        break;
      }
      case "sticky": {
        ctx.shadowColor = "rgba(15,23,42,0.18)";
        ctx.shadowBlur = 6 * Math.min(1, zoom * 2);
        ctx.shadowOffsetY = 2;
        roundRect(p.x, p.y, p.w, p.h, 6);
        ctx.fillStyle = fill === "transparent" ? "#fde047" : fill;
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.strokeStyle = "rgba(0,0,0,0.08)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = st.color || "#3f3f1f";
        ctx.font = `${st.fontSize || 14}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const lines = wrapLines(String(p.data?.text || ""), p.w - 16, "left");
        lines.forEach((line, i) => {
          if (i * (st.fontSize || 14) * 1.35 < p.h - 12)
            ctx.fillText(line, p.x + 8, p.y + 8 + i * (st.fontSize || 14) * 1.35);
        });
        break;
      }
      case "image": {
        const img = ensureImage(obj);
        if (img) {
          ctx.drawImage(img, p.x, p.y, p.w, p.h);
        } else {
          roundRect(p.x, p.y, p.w, p.h, 4);
          ctx.fillStyle = "#e5eaf2";
          ctx.fill();
        }
        break;
      }
      case "connector": {
        const e = connectorEndpoints(obj, useObjectsRef.objects);
        if (e) {
          ctx.beginPath();
          ctx.moveTo(e.x1, e.y1);
          ctx.lineTo(e.x2, e.y2);
          ctx.strokeStyle = stroke;
          ctx.lineWidth = Math.max(1.5, sw);
          ctx.stroke();
          arrowHead(e.x1, e.y1, e.x2, e.y2, Math.max(8, sw * 4));
        }
        break;
      }
      default:
        break;
    }
    ctx.restore();

    // remote user selection tint
    if (remoteSelColors.has(obj.id)) {
      const b = objectBounds(obj);
      ctx.save();
      ctx.strokeStyle = remoteSelColors.get(obj.id);
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
      ctx.restore();
    }

    if (selectedIds.has(obj.id)) {
      drawSelectionOverlay(obj, selectedIds.size === 1);
    }
  }

  function wrapLines(text, maxWidth, align) {
    const cacheKey = `w${maxWidth}|${align}|${text}`;
    const cached = textCache.get(cacheKey);
    if (cached) return cached;
    const lines = [];
    for (const raw of String(text).split("\n")) {
      let line = "";
      for (const word of raw.split(" ")) {
        const candidate = line ? line + " " + word : word;
        if (ctx.measureText(candidate).width > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    if (textCache.size > 900) textCache.clear();
    textCache.set(cacheKey, lines);
    return lines;
  }

  function drawSelectionOverlay(obj, single) {
    const p = obj.payload;
    if (obj.type === "connector") {
      const e = connectorEndpoints(obj, useObjectsRef.objects);
      if (!e) return;
      ctx.save();
      ctx.strokeStyle = SELECTION;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        Math.min(e.x1, e.x2) - 6,
        Math.min(e.y1, e.y2) - 6,
        Math.abs(e.x2 - e.x1) + 12,
        Math.abs(e.y2 - e.y1) + 12
      );
      ctx.restore();
      return;
    }
    const { x, y, w, h } = { x: p.x, y: p.y, w: p.w, h: p.h };
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.save();
    if (p.rot) {
      ctx.translate(cx, cy);
      ctx.rotate(p.rot);
      ctx.translate(-cx, -cy);
    }
    ctx.strokeStyle = SELECTION;
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
    if (single) {
      const hs = 8 / camera.zoom;
      for (const hnd of handlePositions(p)) {
        ctx.fillStyle = HANDLE_FILL;
        ctx.strokeStyle = SELECTION;
        ctx.lineWidth = 1.5 / camera.zoom;
        ctx.beginPath();
        ctx.rect(hnd.x - hs / 2, hnd.y - hs / 2, hs, hs);
        ctx.fill();
        ctx.stroke();
      }
      // rotate handle
      const rh = rotateHandlePos(p);
      ctx.beginPath();
      ctx.moveTo(cx, y - 2);
      ctx.lineTo(cx, rh.y);
      ctx.strokeStyle = SELECTION;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rh.x, rh.y, hs * 0.75, 0, Math.PI * 2);
      ctx.fillStyle = HANDLE_FILL;
      ctx.fill();
      ctx.strokeStyle = SELECTION;
      ctx.stroke();
    }
    ctx.restore();
  }

  function rotateHandlePos(p) {
    return { x: p.x + p.w / 2, y: p.y - 24 / camera.zoom };
  }

  // module-level refs set by render()
  let camera = { x: 0, y: 0, zoom: 1 };
  let useObjectsRef = { objects: new Map() };
  const dirtyFlag = { value: true };
  function dirty() {
    dirtyFlag.value = true;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    dirty();
  }

  function render(cam, objects, opts) {
    camera = cam;
    useObjectsRef.objects = objects;
    if (!dirtyFlag.value) return false;
    dirtyFlag.value = false;

    const { selection = [], remoteSelections, cursors, marquee, preview } = opts;
    const selSet = new Set(selection);

    // remote selections → object id → user color (both maps keyed by userId)
    const remoteSelColors = new Map();
    if (remoteSelections) {
      for (const [uid, ids] of remoteSelections) {
        const color = cursors?.get(uid)?.color || "#8b5cf6";
        for (const id of ids) remoteSelColors.set(id, color);
      }
    }

    // background
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BOARD_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);

    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    // dot grid with adaptive spacing (screen spacing stays 14–56px)
    const base = 25;
    let spacing = base;
    while (spacing * cam.zoom < 14) spacing *= 2;
    const startW = screenToWorld(cam, 0, 0);
    const endW = screenToWorld(cam, w, h);
    ctx.fillStyle = GRID_DOT;
    const dotR = Math.max(0.6, 1.1 * Math.min(1.5, cam.zoom));
    const startX = Math.floor(startW.x / spacing) * spacing;
    const startY = Math.floor(startW.y / spacing) * spacing;
    for (let wx = startX; wx <= endW.x + spacing; wx += spacing) {
      for (let wy = startY; wy <= endW.y + spacing; wy += spacing) {
        const s = worldToScreen(cam, wx, wy);
        ctx.beginPath();
        ctx.arc(s.x, s.y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // visible objects via quadtree (viewport culling)
    const margin = 80 / cam.zoom;
    const visible = quad.query(startW.x - margin, startW.y - margin, endW.x - startW.x + margin * 2, endW.y - startW.y + margin * 2);
    const objs = [];
    for (const id of visible) {
      const obj = objects.get(id);
      if (obj) objs.push(obj);
    }
    objs.sort((a, b) => (a.z || 0) - (b.z || 0));
    // World transform: objects, selection overlays and the in-progress
    // preview are all authored in world coordinates (overlays divide sizes
    // by zoom to stay screen-constant). Without this transform objects
    // ignore camera pan/zoom entirely — they rendered as if camera was
    // always (0,0,zoom=1). Grid/cursors/marquee below use worldToScreen
    // and stay in screen space.
    ctx.save();
    ctx.translate(-cam.x * cam.zoom, -cam.y * cam.zoom);
    ctx.scale(cam.zoom, cam.zoom);
    for (const obj of objs) drawObject(obj, cam, selSet, remoteSelColors);

    // preview (in-progress creation)
    if (preview && preview.type) {
      drawObject(
        { id: "__preview", type: preview.type, payload: preview.payload, z: 1e9 },
        cam,
        new Set(),
        new Map()
      );
    }
    ctx.restore();

    // marquee
    if (marquee) {
      const s1 = worldToScreen(cam, marquee.x, marquee.y);
      const sw2 = marquee.w * cam.zoom;
      const sh2 = marquee.h * cam.zoom;
      ctx.fillStyle = "rgba(16,185,129,0.08)";
      ctx.strokeStyle = "rgba(16,185,129,0.7)";
      ctx.lineWidth = 1;
      ctx.fillRect(s1.x, s1.y, sw2, sh2);
      ctx.strokeRect(s1.x, s1.y, sw2, sh2);
    }

    // remote cursors (screen space)
    if (cursors) {
      for (const cur of cursors.values()) {
        if (cur.view !== "board" || cur.x == null) continue;
        const s = worldToScreen(cam, cur.x, cur.y);
        if (s.x < -40 || s.y < -40 || s.x > w + 40 || s.y > h + 40) continue;
        ctx.save();
        ctx.fillStyle = cur.color;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + 11, s.y + 4);
        ctx.lineTo(s.x + 5, s.y + 11);
        ctx.closePath();
        ctx.fill();
        const label = cur.name || "";
        ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = cur.color;
        roundRect(s.x + 12, s.y + 12, tw + 12, 18, 9);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textBaseline = "middle";
        ctx.fillText(label, s.x + 18, s.y + 21.5);
        ctx.restore();
      }
    }

    return true;
  }

  return { render, resize, dirty, markDirty: dirty };
}
