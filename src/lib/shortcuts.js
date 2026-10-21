// User-customizable keyboard shortcuts (persisted in localStorage).
//
// Only single-letter tool shortcuts are remappable; modifier combos
// (undo/copy/group/etc.) are fixed so they always match muscle memory.

const KEY = "iw.shortcuts.v1";

export const TOOL_LABELS = {
  select: "Select",
  hand: "Pan",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  arrow: "Arrow",
  freehand: "Draw",
  text: "Text",
  sticky: "Sticky note",
  connector: "Connector",
  comment: "Comment",
  frame: "Frame",
  eraser: "Eraser",
};

export const DEFAULT_TOOL_KEYS = {
  select: "v",
  hand: "h",
  rectangle: "r",
  ellipse: "o",
  line: "l",
  arrow: "a",
  freehand: "p",
  text: "t",
  sticky: "n",
  connector: "c",
  comment: "m",
  frame: "f",
  eraser: "e",
};

export function loadShortcuts() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const out = { ...DEFAULT_TOOL_KEYS };
      for (const [tool, key] of Object.entries(parsed || {})) {
        if (tool in out && typeof key === "string" && key.length === 1) out[tool] = key.toLowerCase();
      }
      // select/hand must stay reachable
      return out;
    }
  } catch {}
  return { ...DEFAULT_TOOL_KEYS };
}

export function saveShortcuts(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent("iw-shortcuts-changed"));
  } catch {}
}

export function resetShortcuts() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent("iw-shortcuts-changed"));
  } catch {}
}

// key → tool lookup (last write wins if the user maps a duplicate key)
export function keyToTool(map = loadShortcuts()) {
  const out = {};
  for (const [tool, key] of Object.entries(map)) out[key] = tool;
  return out;
}
