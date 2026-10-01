// Geometry helpers: bounds, rotation, per-type hit testing, connectors.

export function rectIntersectsRect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rotatePoint(px, py, cx, cy, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// Hit-test a world-space point against one object (tolerance in world units).
export function hitTestObject(obj, wx, wy, tol, objects) {
  const p = obj.payload;
  let lx = wx;
  let ly = wy;

  if (p.rot && obj.type !== "line" && obj.type !== "arrow" && obj.type !== "freehand") {
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    const inv = rotatePoint(wx, wy, cx, cy, -p.rot);
    lx = inv.x;
    ly = inv.y;
  }

  switch (obj.type) {
    case "rectangle":
    case "sticky":
    case "text":
    case "image":
      return lx >= p.x - tol && lx <= p.x + p.w + tol && ly >= p.y - tol && ly <= p.y + p.h + tol;
    case "ellipse": {
      const nx = (lx - (p.x + p.w / 2)) / (p.w / 2 + tol);
      const ny = (ly - (p.y + p.h / 2)) / (p.h / 2 + tol);
      return nx * nx + ny * ny <= 1;
    }
    case "line":
    case "arrow": {
      const x2 = p.data?.x2 ?? p.x + p.w;
      const y2 = p.data?.y2 ?? p.y + p.h;
      return distToSegment(lx, ly, p.x, p.y, x2, y2) <= tol + Math.max(2, (p.style?.strokeWidth || 2) / 2);
    }
    case "freehand": {
      const pts = p.data?.points || [];
      if (pts.length < 2) {
        const dx = lx - (p.x + (pts[0]?.[0] || 0));
        const dy = ly - (p.y + (pts[0]?.[1] || 0));
        return dx * dx + dy * dy <= (tol + 4) * (tol + 4);
      }
      for (let i = 1; i < pts.length; i++) {
        if (
          distToSegment(lx, ly, p.x + pts[i - 1][0], p.y + pts[i - 1][1], p.x + pts[i][0], p.y + pts[i][1]) <=
          tol + 4
        )
          return true;
      }
      return false;
    }
    case "connector": {
      const e = connectorEndpoints(obj, objects);
      if (!e) return false;
      return distToSegment(lx, ly, e.x1, e.y1, e.x2, e.y2) <= tol + 6;
    }
    default:
      return false;
  }
}

export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Resolve a connector's endpoints from the objects it links (fall back to
// stored absolute points when the referenced objects are gone).
export function connectorEndpoints(obj, objects) {
  const d = obj.payload.data || {};
  const from = d.fromId ? objects.get(d.fromId) : null;
  const to = d.toId ? objects.get(d.toId) : null;
  let x1 = d.fromPt?.[0];
  let y1 = d.fromPt?.[1];
  let x2 = d.toPt?.[0];
  let y2 = d.toPt?.[1];
  if (from) {
    const b = from.payload;
    x1 = b.x + b.w / 2;
    y1 = b.y + b.h / 2;
  }
  if (to) {
    const b = to.payload;
    x2 = b.x + b.w / 2;
    y2 = b.y + b.h / 2;
  }
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
  return { x1, y1, x2, y2 };
}

// Ramer–Douglas–Peucker simplification for freehand strokes.
export function simplifyPoints(points, epsilon) {
  if (points.length < 3) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = 0;
    let index = -1;
    const [x1, y1] = points[start];
    const [x2, y2] = points[end];
    for (let i = start + 1; i < end; i++) {
      const d = distToSegment(points[i][0], points[i][1], x1, y1, x2, y2);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > epsilon && index > 0) {
      keep[index] = true;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// 8 resize handles for a (possibly rotated) rect: nw n ne e se s sw w
export function handlePositions(p) {
  const { x, y, w, h, rot = 0 } = p;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const corners = [
    [x, y, "nw"],
    [cx, y, "n"],
    [x + w, y, "ne"],
    [x + w, cy, "e"],
    [x + w, y + h, "se"],
    [cx, y + h, "s"],
    [x, y + h, "sw"],
    [x, cy, "w"],
  ];
  if (!rot) return corners.map(([hx, hy, id]) => ({ id, x: hx, y: hy }));
  return corners.map(([hx, hy, id]) => {
    const rp = rotatePoint(hx, hy, cx, cy, rot);
    return { id, x: rp.x, y: rp.y };
  });
}
