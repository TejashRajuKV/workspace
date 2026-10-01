// ============================================================
// Interaction manager: pointer/keyboard → operations.
//
// Interaction → operation mapping:
//   - drags mutate object payloads DIRECTLY each frame (60fps) and emit
//     throttled MOVE/RESIZE/ROTATE ops (send-only, ~20Hz) so collaborators
//     see the motion live; the aggregated op lands in history at pointer-up
//   - creations/deletions are normal ops with inverse-op history entries
//   - presence (cursor + selection) publishes throttled at ≤20Hz
// ============================================================

import { useBoard, boardRefs, sendPresence } from "@/state/board";
import { OP, newObjectId, LIMITS } from "@/shared/protocol";
import { makeStyle, applyCanvasOp, objectBounds } from "@/shared/canvasOps";
import { screenToWorld, zoomCameraAt, panCamera } from "./camera";
import { hitTestObject, handlePositions, rotatePoint, simplifyPoints, rectIntersectsRect } from "./geometry";
import { buildHistoryEntry } from "./history";

const DRAG_EMIT_MS = 50;

export function createInteractions(canvas, engine) {
  const { quad, renderer, onEditObject, onNewText } = engine;

  let mode = null; // pan|marquee|move|resize|rotate|draw|freehand|connect|erase
  let startWorld = null;
  let lastWorld = null;
  let spaceHeld = false;
  let connectFrom = null;
  let moved = false;
  let dragAccum = { dx: 0, dy: 0, lastEmitX: 0, lastEmitY: 0, lastEmit: 0 };
  let resizeOrig = null;
  let rotateOrig = null;
  let eraseHit = new Set();

  const store = () => useBoard.getState();

  // ---------- helpers ----------
  function evtWorld(e) {
    const rect = canvas.getBoundingClientRect();
    return screenToWorld(store().camera, e.clientX - rect.left, e.clientY - rect.top);
  }

  function tol() {
    return 6 / store().camera.zoom;
  }

  function hitAt(wx, wy, excludeIds) {
    const s = store();
    const margin = 12 / s.camera.zoom;
    const candidates = quad.query(wx - margin, wy - margin, margin * 2, margin * 2);
    const hits = [];
    for (const id of candidates) {
      const obj = s.objects.get(id);
      if (!obj) continue;
      if (excludeIds?.has(id)) continue;
      hits.push(obj);
    }
    hits.sort((a, b) => (b.z || 0) - (a.z || 0));
    for (const obj of hits) {
      if (hitTestObject(obj, wx, wy, tol(), s.objects)) return obj;
    }
    return null;
  }

  function nextZ() {
    let max = 0;
    for (const o of store().objects.values()) if ((o.z || 0) > max) max = o.z || 0;
    return max + 1;
  }

  function markChanged(id) {
    boardRefs.changedIds.add(id);
  }
  function applyLocal(op) {
    // local-only mutation (no op emission) for 60fps dragging
    const s = store();
    applyCanvasOp(s.objects, op, s.me?.id || "me", Date.now());
    markChanged(op.oid);
    renderer?.markDirty?.();
  }

  // emit an op to the server WITHOUT applying locally (already applied)
  function emitOnly(op) {
    const s = store();
    if (s.role === "viewer" || !s.wsId) return;
    s.emitWithoutLocalApply(op);
  }

  function submit(op, withHistory = true) {
    const s = store();
    if (s.role === "viewer" || !s.wsId) return;
    const entry = withHistory ? buildHistoryEntry(s.objects, op) : null;
    s.submitOps([op], entry ? [entry] : undefined);
  }

  // ---------- pointer events ----------
  function onPointerDown(e) {
    if (e.button === 2) return;
    canvas.setPointerCapture?.(e.pointerId);
    const world = evtWorld(e);
    startWorld = world;
    lastWorld = world;
    moved = false;
    const s = store();
    const tool = s.tool;

    const wantPan = tool === "hand" || e.button === 1 || spaceHeld;
    if (wantPan) {
      mode = "pan";
      return;
    }

    if (tool === "select") {
      const sel = new Set(s.selection);
      // handles first (single selection only)
      if (s.selection.length === 1) {
        const obj = s.objects.get(s.selection[0]);
        if (obj && obj.type !== "connector") {
          const handle = hitHandle(obj, world.x, world.y);
          if (handle === "rot") {
            mode = "rotate";
            rotateOrig = {
              rot: obj.payload.rot || 0,
              startAngle: Math.atan2(world.y - (obj.payload.y + obj.payload.h / 2), world.x - (obj.payload.x + obj.payload.w / 2)),
            };
            return;
          }
          if (handle) {
            mode = "resize";
            resizeOrig = {
              rect: { x: obj.payload.x, y: obj.payload.y, w: obj.payload.w, h: obj.payload.h },
              rot: obj.payload.rot || 0,
              handle,
            };
            dragAccum = { ...dragAccum, lastEmit: Date.now() };
            return;
          }
        }
      }
      const hit = hitAt(world.x, world.y);
      if (hit) {
        if (e.shiftKey) {
          if (sel.has(hit.id)) sel.delete(hit.id);
          else sel.add(hit.id);
        } else if (!sel.has(hit.id)) {
          sel.clear();
          sel.add(hit.id);
        }
        s.setSelection([...sel]);
        sendPresence({ selection: [...sel] });
        mode = "move";
        dragAccum = { dx: 0, dy: 0, lastEmitX: 0, lastEmitY: 0, lastEmit: Date.now() };
      } else {
        mode = "marquee";
        boardRefs.marquee = { x: world.x, y: world.y, w: 0, h: 0 };
      }
      return;
    }

    if (tool === "eraser") {
      mode = "erase";
      eraseHit = new Set();
      eraseAt(world.x, world.y);
      return;
    }

    if (tool === "connector") {
      const hit = hitAt(world.x, world.y, new Set(["connector"]));
      if (hit && !connectFrom) {
        connectFrom = hit.id;
        mode = "connect";
      } else if (hit && connectFrom && hit.id !== connectFrom) {
        finishConnector(hit.id);
      } else if (!hit && connectFrom) {
        // click empty space → connector to a fixed point
        finishConnector(null, world);
      } else if (hit && connectFrom === hit.id) {
        connectFrom = null;
        mode = null;
        renderer?.markDirty?.();
      }
      return;
    }

    if (tool === "freehand") {
      mode = "freehand";
      dragAccum.points = [[world.x, world.y]];
      return;
    }

    if (tool === "text") {
      onNewText({ x: world.x, y: world.y, existing: null });
      mode = null;
      return;
    }

    if (["rectangle", "ellipse", "line", "arrow", "sticky"].includes(tool)) {
      mode = "draw";
      renderer?.markDirty?.();
      return;
    }
  }

  function hitHandle(obj, wx, wy) {
    const p = obj.payload;
    const t = 9 / store().camera.zoom;
    const rh = { x: p.x + p.w / 2, y: p.y - 24 / store().camera.zoom };
    if (p.rot) {
      const c = { x: p.x + p.w / 2, y: p.y + p.h / 2 };
      const rp = rotatePoint(rh.x, rh.y, c.x, c.y, p.rot);
      if (Math.hypot(wx - rp.x, wy - rp.y) <= t) return "rot";
    } else if (Math.hypot(wx - rh.x, wy - rh.y) <= t) {
      return "rot";
    }
    for (const h of handlePositions(p)) {
      if (Math.hypot(wx - h.x, wy - h.y) <= t) return h.id;
    }
    return null;
  }

  function eraseAt(wx, wy) {
    const hit = hitAt(wx, wy);
    if (hit && !eraseHit.has(hit.id)) {
      eraseHit.add(hit.id);
      submit({ type: OP.DELETE, oid: hit.id, p: {} }, true);
    }
  }

  function finishConnector(toId, toWorld) {
    const s = store();
    const id = newObjectId();
    const fromObj = s.objects.get(connectFrom);
    const payload = {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      rot: 0,
      style: makeStyle({ stroke: "#64748b", strokeWidth: 2 }),
      data: {
        fromId: connectFrom,
        toId: toId,
        fromPt: null,
        toPt: toId ? null : [toWorld.x, toWorld.y],
      },
    };
    if (!toId && toWorld) {
      payload.x = Math.min(fromObj?.payload.x || 0, toWorld.x);
      payload.y = Math.min(fromObj?.payload.y || 0, toWorld.y);
    }
    connectFrom = null;
    mode = null;
    boardRefs.preview = null;
    submit({ type: OP.CREATE, oid: id, p: { object: { id, type: "connector", payload, z: nextZ() } } }, true);
    s.setTool("connector");
    renderer?.markDirty?.();
  }

  function onPointerMove(e) {
    const world = evtWorld(e);
    const s = store();
    if (!mode && s.tool === "select") {
      sendPresence({ cursor: { x: world.x, y: world.y }, view: "board" });
      return;
    }
    if (!mode) return;
    if (Math.hypot(world.x - lastWorld.x, world.y - lastWorld.y) > 0) moved = true;

    switch (mode) {
      case "pan": {
        const dx = world.x - lastWorld.x;
        const dy = world.y - lastWorld.y;
        // convert world delta to camera shift (keeps zoom intact)
        s.setCamera({ ...s.camera, x: s.camera.x - dx, y: s.camera.y - dy });
        break;
      }
      case "marquee": {
        const m = boardRefs.marquee;
        m.w = world.x - m.x;
        m.h = world.y - m.y;
        if (m.w < 0) {
          m.x = world.x;
          m.w = -m.w;
        }
        if (m.h < 0) {
          m.y = world.y;
          m.h = -m.h;
        }
        renderer?.markDirty?.();
        break;
      }
      case "move": {
        const dx = world.x - lastWorld.x;
        const dy = world.y - lastWorld.y;
        const op = { type: OP.MOVE, oid: null, p: { dx, dy } };
        for (const id of s.selection) {
          op.oid = id;
          applyLocal(op);
        }
        dragAccum.dx += dx;
        dragAccum.dy += dy;
        maybeEmitMove();
        break;
      }      case "resize": {
        const id = s.selection[0];
        const obj = s.objects.get(id);
        if (!obj) break;
        const r = computeResize(resizeOrig, world);
        const op = { type: OP.RESIZE, oid: id, p: r };
        applyLocal(op);
        if (Date.now() - dragAccum.lastEmit > DRAG_EMIT_MS) {
          dragAccum.lastEmit = Date.now();
          emitOnly(op);
          dragAccum.lastResize = r;
        }
        break;
      }
      case "rotate": {
        const id = s.selection[0];
        const obj = s.objects.get(id);
        if (!obj) break;
        const c = {
          x: resizeOrig ? resizeOrig.rect.x + resizeOrig.rect.w / 2 : obj.payload.x + obj.payload.w / 2,
          y: resizeOrig ? resizeOrig.rect.y + resizeOrig.rect.h / 2 : obj.payload.y + obj.payload.h / 2,
        };
        let rot = rotateOrig.rot + (Math.atan2(world.y - c.y, world.x - c.x) - rotateOrig.startAngle);
        if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
        const op = { type: OP.ROTATE, oid: id, p: { rot } };
        applyLocal(op);
        if (Date.now() - dragAccum.lastEmit > DRAG_EMIT_MS) {
          dragAccum.lastEmit = Date.now();
          emitOnly(op);
        }
        break;
      }
      case "draw": {
        renderer?.markDirty?.();
        break;
      }
      case "freehand": {
        const pts = dragAccum.points;
        const last = pts[pts.length - 1];
        if (Math.hypot(world.x - last[0], world.y - last[1]) > 1.5 / s.camera.zoom) {
          pts.push([world.x, world.y]);
          renderer?.markDirty?.();
        }
        break;
      }
      case "erase": {
        eraseAt(world.x, world.y);
        break;
      }
      case "connect": {
        renderer?.markDirty?.();
        break;
      }
      default:
        break;
    }
    lastWorld = world;
    sendPresence({ cursor: { x: world.x, y: world.y }, view: "board" });
  }

  function maybeEmitMove() {
    const now = Date.now();
    if (now - dragAccum.lastEmit < DRAG_EMIT_MS) return;
    const dx = dragAccum.dx - dragAccum.lastEmitX;
    const dy = dragAccum.dy - dragAccum.lastEmitY;
    if (!dx && !dy) return;
    dragAccum.lastEmit = now;
    dragAccum.lastEmitX += dx;
    dragAccum.lastEmitY += dy;
    for (const id of store().selection) {
      emitOnly({ type: OP.MOVE, oid: id, p: { dx, dy } });
    }
  }

  function computeResize(orig, world) {
    const { rect, rot, handle } = orig;
    // pointer in object-local (unrotated) space around the ORIGINAL center
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const local = rot ? rotatePoint(world.x, world.y, cx, cy, -rot) : world;
    let nx = rect.x;
    let ny = rect.y;
    let nw = rect.w;
    let nh = rect.h;
    const minS = 4;
    if (handle.includes("w")) nx = Math.min(local.x, rect.x + rect.w - minS);
    if (handle.includes("e")) nw = Math.max(minS, local.x - rect.x);
    if (handle.includes("n")) ny = Math.min(local.y, rect.y + rect.h - minS);
    if (handle.includes("s")) nh = Math.max(minS, local.y - rect.y);
    if (handle === "n") { nx = rect.x; nw = rect.w; }
    if (handle === "s") { nx = rect.x; nw = rect.w; }
    if (handle === "e") { ny = rect.y; nh = rect.h; }
    if (handle === "w") { ny = rect.y; nh = rect.h; }
    nw = Math.max(minS, nw);
    nh = Math.max(minS, nh);

    if (!rot) return { x: nx, y: ny, w: nw, h: nh };

    // keep the visual anchor fixed under rotation:
    //   c' = (I − R)⁻¹ (A − R u)  with u = anchor in payload coords
    const anchors = {
      nw: [rect.x, rect.y],
      n: [rect.x + rect.w / 2, rect.y],
      ne: [rect.x + rect.w, rect.y],
      e: [rect.x + rect.w, rect.y + rect.h / 2],
      se: [rect.x + rect.w, rect.y + rect.h],
      s: [rect.x + rect.w / 2, rect.y + rect.h],
      sw: [rect.x, rect.y + rect.h],
      w: [rect.x, rect.y + rect.h / 2],
    };
    const [ux, uy] = anchors[handle];
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // A = original visual anchor = c + R(u − c)
    const ax = cx + (ux - cx) * cos - (uy - cy) * sin;
    const ay = cy + (ux - cx) * sin + (uy - cy) * cos;
    const det = (1 - cos) * (1 - cos) + sin * sin;
    if (det < 1e-9) return { x: nx, y: ny, w: nw, h: nh };
    // solve (I − R) c' = A − R u  →  [1−cos, sin; −sin, 1−cos] c' = [ax − (ux cos − uy sin); ay − (ux sin + uy cos)]
    const b1 = ax - (ux * cos - uy * sin);
    const b2 = ay - (ux * sin + uy * cos);
    const cxn = (b1 * (1 - cos) - b2 * sin) / det;
    const cyn = (b1 * sin + b2 * (1 - cos)) / det;
    return { x: cxn - nw / 2, y: cyn - nh / 2, w: nw, h: nh };
  }

  function onPointerUp(e) {
    const s = store();
    const world = evtWorld(e);

    switch (mode) {
      case "move": {
        // residual delta + aggregate history entry
        const rdx = dragAccum.dx - dragAccum.lastEmitX;
        const rdy = dragAccum.dy - dragAccum.lastEmitY;
        for (const id of s.selection) {
          if (rdx || rdy) emitOnly({ type: OP.MOVE, oid: id, p: { dx: rdx, dy: rdy } });
        }
        if (dragAccum.dx || dragAccum.dy) {
          pushAggregateMoveHistory([...s.selection], dragAccum.dx, dragAccum.dy);
        }
        break;
      }
      case "resize": {
        const id = s.selection[0];
        const obj = s.objects.get(id);
        if (obj) {
          const r = { x: obj.payload.x, y: obj.payload.y, w: obj.payload.w, h: obj.payload.h };
          const entry = {
            apply: { type: OP.RESIZE, oid: id, p: r },
            inverse: { type: OP.RESIZE, oid: id, p: resizeOrig.rect },
          };
          s.pushHistoryEntry(entry);
        }
        break;
      }
      case "rotate": {
        const id = s.selection[0];
        const obj = s.objects.get(id);
        if (obj) {
          const entry = {
            apply: { type: OP.ROTATE, oid: id, p: { rot: obj.payload.rot || 0 } },
            inverse: { type: OP.ROTATE, oid: id, p: { rot: rotateOrig.rot } },
          };
          s.pushHistoryEntry(entry);
        }
        break;
      }
      case "marquee": {
        const m = boardRefs.marquee;
        boardRefs.marquee = null;
        if (m && (m.w > 2 || m.h > 2)) {
          const rect = { x: m.x, y: m.y, w: m.w, h: m.h };
          const ids = [];
          const candidates = quad.query(rect.x, rect.y, rect.w, rect.h);
          for (const id of candidates) {
            const obj = s.objects.get(id);
            if (obj && rectIntersectsRect(objectBounds(obj), rect)) ids.push(id);
          }
          s.setSelection(ids);
          sendPresence({ selection: ids });
        } else {
          s.setSelection([]);
          sendPresence({ selection: [] });
        }
        break;
      }
      case "draw": {
        const tool = s.tool;
        const a = startWorld;
        const b = world;
        const w = Math.abs(b.x - a.x);
        const h = Math.abs(b.y - a.y);
        const tiny = w < 5 / s.camera.zoom && h < 5 / s.camera.zoom;
        if (tool === "rectangle" || tool === "ellipse") {
          const id = newObjectId();
          const payload = {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            w: Math.max(tiny ? 80 : w, 2),
            h: Math.max(tiny ? 60 : h, 2),
            rot: 0,
            style: makeStyle(s.style),
            data: {},
          };
          submit(
            { type: OP.CREATE, oid: id, p: { object: { id, type: tool, payload, z: nextZ() } } },
            true
          );
        } else if (tool === "line" || tool === "arrow") {
          const id = newObjectId();
          const payload = {
            x: a.x,
            y: a.y,
            w: Math.max(Math.abs(b.x - a.x), 2),
            h: Math.max(Math.abs(b.y - a.y), 2),
            rot: 0,
            style: makeStyle({ ...s.style, fill: "transparent" }),
            data: { x2: b.x, y2: b.y },
          };
          submit(
            { type: OP.CREATE, oid: id, p: { object: { id, type: tool, payload, z: nextZ() } } },
            true
          );
        } else if (tool === "sticky") {
          const id = newObjectId();
          const payload = {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            w: Math.max(tiny ? 180 : w, 60),
            h: Math.max(tiny ? 180 : h, 60),
            rot: 0,
            style: makeStyle({ ...s.style, fill: s.style.fill === "transparent" ? "#fde047" : s.style.fill, color: "#3f3f1f", fontSize: 14, align: "left" }),
            data: { text: "" },
          };
          const op = { type: OP.CREATE, oid: id, p: { object: { id, type: "sticky", payload, z: nextZ() } } };
          submit(op, true);
          onEditObject({ objId: id, kind: "sticky" });
        }
        // return to select after one shape (like most whiteboards)
        s.setTool("select");
        break;
      }
      case "freehand": {
        let pts = dragAccum.points || [];
        if (pts.length >= 2) {
          pts = simplifyPoints(pts, 1.2 / s.camera.zoom);
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (const [dx, dy] of pts) {
            if (dx < minX) minX = dx;
            if (dy < minY) minY = dy;
            if (dx > maxX) maxX = dx;
            if (dy > maxY) maxY = dy;
          }
          const id = newObjectId();
          const payload = {
            x: minX,
            y: minY,
            w: Math.max(maxX - minX, 2),
            h: Math.max(maxY - minY, 2),
            rot: 0,
            style: makeStyle({ ...s.style, fill: "transparent", strokeWidth: Math.max(2, s.style.strokeWidth) }),
            data: { points: pts.map(([x, y]) => [x - minX, y - minY]) },
          };
          submit(
            { type: OP.CREATE, oid: id, p: { object: { id, type: "freehand", payload, z: nextZ() } } },
            true
          );
        }
        break;
      }
      default:
        break;
    }

    mode = null;
    dragAccum = { dx: 0, dy: 0, lastEmitX: 0, lastEmitY: 0, lastEmit: 0 };
    boardRefs.preview = null;
    renderer?.markDirty?.();
  }

  function pushAggregateMoveHistory(ids, dx, dy) {
    // Multi-object move: compound entry that undo/redo expands to one op each.
    const s = store();
    const compound = {
      apply: ids.map((id) => ({ type: OP.MOVE, oid: id, p: { dx, dy } })),
      inverse: ids.map((id) => ({ type: OP.MOVE, oid: id, p: { dx: -dx, dy: -dy } })),
    };
    s.pushHistoryEntry(compound);
  }

  function onWheel(e) {
    e.preventDefault();
    const s = store();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      s.setCamera(panCamera(s.camera, -e.deltaY, 0));
    } else {
      const factor = Math.pow(0.999, e.deltaY);
      s.setCamera(zoomCameraAt(s.camera, sx, sy, factor));
    }
    renderer?.markDirty?.();
  }

  function onDoubleClick(e) {
    const world = evtWorld(e);
    const hit = hitAt(world.x, world.y);
    if (hit && (hit.type === "text" || hit.type === "sticky")) {
      onEditObject({ objId: hit.id, kind: hit.type });
    }
  }

  // ---------- keyboard ----------
  function onKeyDown(e) {
    const target = e.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const s = store();
    if (e.code === "Space") {
      spaceHeld = true;
      canvas.style.cursor = "grab";
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) s.redo();
      else s.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      s.redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicateSelection();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      const clip = s.selection.map((id) => s.objects.get(id)).filter(Boolean);
      if (clip.length) s.setClipboard(clip.map((o) => JSON.parse(JSON.stringify({ type: o.type, payload: o.payload, z: o.z }))));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      pasteClipboard();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (s.selection.length) {
        for (const id of s.selection) submit({ type: OP.DELETE, oid: id, p: {} }, true);
        s.setSelection([]);
        sendPresence({ selection: [] });
      }
      return;
    }
    if (e.key === "Escape") {
      connectFrom = null;
      boardRefs.preview = null;
      if (s.selection.length) {
        s.setSelection([]);
        sendPresence({ selection: [] });
      }
      renderer?.markDirty?.();
      return;
    }
    if (e.key.startsWith("Arrow") && s.selection.length) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      for (const id of s.selection) {
        submit({ type: OP.MOVE, oid: id, p: { dx, dy } }, true);
      }
      return;
    }
    // tool shortcuts
    const keyTools = {
      v: "select",
      h: "hand",
      r: "rectangle",
      o: "ellipse",
      l: "line",
      a: "arrow",
      p: "freehand",
      t: "text",
      n: "sticky",
      c: "connector",
      e: "eraser",
    };
    const t = keyTools[e.key.toLowerCase()];
    if (t && !e.ctrlKey && !e.metaKey && !e.altKey) {
      s.setTool(t);
      updateCursor();
    }
  }

  function onKeyUp(e) {
    if (e.code === "Space") {
      spaceHeld = false;
      updateCursor();
    }
  }

  function duplicateSelection() {
    const s = store();
    if (!s.selection.length || s.role === "viewer") return;
    const ops = [];
    const entries = [];
    const newIds = [];
    for (const id of s.selection) {
      const obj = s.objects.get(id);
      if (!obj || obj.type === "connector") continue;
      const newId = newObjectId();
      newIds.push(newId);
      const payload = JSON.parse(JSON.stringify(obj.payload));
      payload.x += 24;
      payload.y += 24;
      const op = { type: OP.CREATE, oid: newId, p: { object: { id: newId, type: obj.type, payload, z: nextZ() } } };
      ops.push(op);
      entries.push(buildHistoryEntry(s.objects, op));
      // apply happens inside submitOps
    }
    if (ops.length) {
      s.submitOps(ops, entries);
      s.setSelection(newIds);
    }
  }

  function pasteClipboard() {
    const s = store();
    if (!s.clipboard.length || s.role === "viewer") return;
    const ops = [];
    const entries = [];
    const newIds = [];
    for (const rec of s.clipboard) {
      const newId = newObjectId();
      newIds.push(newId);
      const payload = JSON.parse(JSON.stringify(rec.payload));
      payload.x += 24;
      payload.y += 24;
      const op = { type: OP.CREATE, oid: newId, p: { object: { id: newId, type: rec.type, payload, z: nextZ() } } };
      ops.push(op);
      entries.push(buildHistoryEntry(s.objects, op));
    }
    s.submitOps(ops, entries);
    s.setSelection(newIds);
  }

  function updateCursor() {
    const tool = store().tool;
    canvas.style.cursor =
      tool === "hand" ? "grab" :
      tool === "select" ? "default" :
      tool === "text" ? "text" :
      tool === "eraser" ? "cell" :
      "crosshair";
  }

  // preview drawing data consumed by the renderer
  function getPreview() {
    if (mode === "draw") {
      const s = store();
      const tool = s.tool;
      const a = startWorld;
      const b = lastWorld;
      if (!a || !b || !["rectangle", "ellipse", "line", "arrow", "sticky"].includes(tool)) return null;
      if (tool === "line" || tool === "arrow") {
        return {
          type: tool,
          payload: { x: a.x, y: a.y, w: Math.abs(b.x - a.x) || 1, h: Math.abs(b.y - a.y) || 1, rot: 0, style: makeStyle({ ...s.style, fill: "transparent" }), data: { x2: b.x, y2: b.y } },
        };
      }
      return {
        type: tool,
        payload: {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          w: Math.max(Math.abs(b.x - a.x), 2),
          h: Math.max(Math.abs(b.y - a.y), 2),
          rot: 0,
          style: makeStyle(tool === "sticky" ? { ...s.style, fill: "#fde047" } : s.style),
          data: tool === "sticky" ? { text: "" } : {},
        },
      };
    }
    if (mode === "freehand" && dragAccum.points?.length > 1) {
      const s = store();
      const pts = dragAccum.points;
      return {
        type: "freehand",
        payload: { x: pts[0][0], y: pts[0][1], w: 1, h: 1, rot: 0, style: makeStyle({ ...s.style, fill: "transparent" }), data: { points: pts.map(([x, y]) => [x - pts[0][0], y - pts[0][1]]) } },
      };
    }
    if (mode === "connect" && connectFrom) {
      const s = store();
      const from = s.objects.get(connectFrom);
      if (from) {
        const fp = from.payload;
        return {
          type: "line",
          payload: { x: fp.x + fp.w / 2, y: fp.y + fp.h / 2, w: 1, h: 1, rot: 0, style: makeStyle({ stroke: "#64748b", fill: "transparent" }), data: { x2: lastWorld.x, y2: lastWorld.y } },
        };
      }
    }
    return null;
  }

  // ---------- wiring ----------
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  updateCursor();

  return {
    destroy() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    },
    getPreview,
    updateCursor,
    isConnecting: () => mode === "connect" && connectFrom,
    cancelConnect: () => {
      connectFrom = null;
      mode = null;
      boardRefs.preview = null;
    },
  };
}
