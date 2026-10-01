// ============================================================
// Region Quadtree — spatial index for the infinite canvas.
//
// Why a quadtree (vs. spatial hash / R-tree):
//   - point + rect queries in O(log n) with a fixed, cache-friendly shape
//   - deterministic and dependency-free; easy to make removal O(1) by
//     tracking the owning node per object id
//   - objects beyond the root extents fall back to an always-scanned
//     "extras" bucket (practically never hit — root covers ±16.7M units)
//
// Used for: viewport culling (render), hit testing (pick), marquee select.
// ============================================================

const ROOT_HALF = 1 << 24; // ±16,777,216 world units
const CAPACITY = 12;
const MAX_DEPTH = 20;

function newNode(x, y, half, depth) {
  return { x, y, half, depth, items: new Set(), children: null };
}

function intersects(b, x, y, w, h) {
  return b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y;
}

export class Quadtree {
  constructor() {
    this.root = newNode(-ROOT_HALF, -ROOT_HALF, ROOT_HALF * 2, 0);
    this.itemBounds = new Map(); // id → bounds
    this.itemNode = new Map(); // id → node (O(1) removal)
  }

  insert(id, b) {
    this.remove(id);
    this.itemBounds.set(id, { x: b.x, y: b.y, w: Math.max(b.w, 0.01), h: Math.max(b.h, 0.01) });
    if (
      b.x < -ROOT_HALF ||
      b.y < -ROOT_HALF ||
      b.x + b.w > ROOT_HALF ||
      b.y + b.h > ROOT_HALF
    ) {
      this.root.items.add(id);
      this.itemNode.set(id, this.root);
      return;
    }
    this._insert(this.root, id);
  }

  _insert(node, id) {
    const b = this.itemBounds.get(id);
    if (node.children) {
      for (const child of node.children) {
        if (intersects(b, child.x, child.y, child.half, child.half)) this._insert(child, id);
      }
      return;
    }
    node.items.add(id);
    this.itemNode.set(id, node);
    if (node.items.size > CAPACITY && node.depth < MAX_DEPTH) this._subdivide(node);
  }

  _subdivide(node) {
    const half = node.half / 2;
    node.children = [
      newNode(node.x, node.y, half, node.depth + 1),
      newNode(node.x + half, node.y, half, node.depth + 1),
      newNode(node.x, node.y + half, half, node.depth + 1),
      newNode(node.x + half, node.y + half, half, node.depth + 1),
    ];
    const ids = [...node.items];
    node.items.clear();
    for (const id of ids) {
      this.itemNode.delete(id);
      this._insert(node, id);
    }
  }

  remove(id) {
    const node = this.itemNode.get(id);
    if (node) {
      node.items.delete(id);
      this.itemNode.delete(id);
    }
    this.itemBounds.delete(id);
  }

  update(id, b) {
    this.insert(id, b);
  }

  // All object ids whose bounds intersect the query rect.
  query(x, y, w, h, out = []) {
    out.length = 0;
    this._query(this.root, x, y, w, h, out);
    return out;
  }

  _query(node, x, y, w, h, out) {
    for (const id of node.items) {
      const b = this.itemBounds.get(id);
      if (b && intersects(b, x, y, w, h)) out.push(id);
    }
    if (node.children) {
      for (const child of node.children) {
        if (intersects({ x: child.x, y: child.y, w: child.half, h: child.half }, x, y, w, h))
          this._query(child, x, y, w, h, out);
      }
    }
  }

  get size() {
    return this.itemBounds.size;
  }

  clear() {
    this.root = newNode(-ROOT_HALF, -ROOT_HALF, ROOT_HALF * 2, 0);
    this.itemBounds.clear();
    this.itemNode.clear();
  }
}
