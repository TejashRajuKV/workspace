"use client";

// Keyboard shortcut editor. Tool keys are remappable and persisted; fixed
// modifier shortcuts are listed for reference.

import { useState } from "react";
import { X, RotateCcw, Keyboard } from "lucide-react";
import {
  DEFAULT_TOOL_KEYS,
  TOOL_LABELS,
  loadShortcuts,
  saveShortcuts,
  resetShortcuts,
} from "@/lib/shortcuts";

const FIXED = [
  ["Undo / Redo", "Ctrl+Z / Ctrl+Shift+Z"],
  ["Duplicate", "Ctrl+D"],
  ["Copy / Paste", "Ctrl+C / Ctrl+V"],
  ["Group / Ungroup", "Ctrl+G / Ctrl+Shift+G"],
  ["Delete", "Del"],
  ["Pan", "Space or middle-drag"],
  ["Nudge", "Arrow keys (Shift = 10px)"],
];

export default function ShortcutsDialog({ open, onClose }) {
  const [map, setMap] = useState(loadShortcuts);
  if (!open) return null;

  const setKey = (tool, value) => {
    const key = String(value || "").slice(0, 1).toLowerCase();
    if (!key || !/[a-z0-9]/.test(key)) return;
    const next = { ...map, [tool]: key };
    setMap(next);
    saveShortcuts(next);
  };

  const reset = () => {
    resetShortcuts();
    setMap({ ...DEFAULT_TOOL_KEYS });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-[#43272e] bg-[#201317] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#43272e]">
          <span className="text-sm font-semibold text-[#fbeeda] flex items-center gap-2">
            <Keyboard size={15} /> Keyboard shortcuts
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={reset}
              className="btn btn-ghost px-2 py-1 text-xs"
              title="Reset to defaults"
            >
              <RotateCcw size={13} /> Reset
            </button>
            <button className="p-1 rounded hover:bg-[#332026] text-[#c3a596]" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[#a1847a] mb-2">
              Tools (click a key to change)
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {Object.keys(DEFAULT_TOOL_KEYS).map((tool) => (
                <div
                  key={tool}
                  className="flex items-center justify-between rounded-md bg-[#170d12] px-2.5 py-1.5"
                >
                  <span className="text-xs text-[#c3a596]">{TOOL_LABELS[tool] || tool}</span>
                  <input
                    value={map[tool] || ""}
                    maxLength={1}
                    onChange={(e) => setKey(tool, e.target.value)}
                    className="w-8 text-center uppercase bg-[#2a181d] border border-[#43272e] rounded px-1 py-0.5 text-xs text-[#fbeeda] outline-none focus:border-amber-500"
                  />
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[#a1847a] mb-2">
              Fixed
            </div>
            <div className="space-y-1">
              {FIXED.map(([label, keys]) => (
                <div
                  key={label}
                  className="flex items-center justify-between rounded-md bg-[#170d12] px-2.5 py-1.5"
                >
                  <span className="text-xs text-[#c3a596]">{label}</span>
                  <span className="text-[11px] font-mono text-[#fbeeda]">{keys}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
