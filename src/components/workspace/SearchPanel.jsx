"use client";

// Cross-file text search for the virtual file system.

import { useEffect, useMemo, useRef, useState } from "react";
import { File as FileIcon, Replace, Search, X } from "lucide-react";
import { useCode } from "@/state/code";
import TextOperation from "@/shared/ot";
import { useBoard } from "@/state/board";
import { toast, confirmDialog } from "./Feedback";

const MAX_MATCHES = 300;

function countMatches(content, query, caseSensitive) {
  if (!query) return 0;
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
  return (content.match(re) || []).length;
}

// Minimal retain/delete/insert op between the old and new document content.
function opFromChange(before, after) {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return new TextOperation()
    .retain(p)
    .delete(before.length - p - s)
    .insert(after.slice(p, after.length - s))
    .retain(s);
}

export default function SearchPanel({ open, onClose }) {
  const docs = useCode((s) => s.docs);
  const inputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const results = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return { matches: [], files: 0, truncated: false };
    const needle = caseSensitive ? q : q.toLowerCase();
    const matches = [];
    let files = 0;
    let truncated = false;
    for (const doc of docs) {
      if (doc.isFolder || !doc.content) continue;
      const lines = doc.content.split("\n");
      let hits = 0;
      for (let i = 0; i < lines.length; i++) {
        const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
        const at = hay.indexOf(needle);
        if (at < 0) continue;
        hits++;
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        matches.push({
          docId: doc.id,
          path: doc.path,
          line: i + 1,
          text: lines[i].slice(Math.max(0, at - 40), at + needle.length + 60).trim(),
        });
      }
      if (hits) files++;
      if (truncated) break;
    }
    return { matches, files, truncated };
  }, [docs, query, caseSensitive]);

  // exact occurrence count for the replace row (the match list is capped)
  const totalHits = useMemo(() => {
    const q = query.trim();
    if (!showReplace || q.length < 2) return 0;
    return docs.reduce(
      (n, d) => (d.isFolder || !d.content ? n : n + countMatches(d.content, q, caseSensitive)),
      0
    );
  }, [docs, query, caseSensitive, showReplace]);

  if (!open) return null;

  const replaceAll = async () => {
    const q = query.trim();
    if (q.length < 2) return;
    if (useBoard.getState().role === "viewer") {
      toast("Viewers cannot replace text", "error");
      return;
    }
    const ok = await confirmDialog({
      title: "Replace in all files?",
      message: `Every occurrence of "${q}" across the workspace will be replaced. This syncs to all collaborators.`,
      confirmLabel: "Replace all",
      danger: true,
    });
    if (!ok) return;

    setBusy(true);
    let files = 0;
    let total = 0;
    try {
      const store = useCode.getState();
      for (const doc of docs) {
        if (doc.isFolder || !doc.content) continue;
        const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
        store.seedDocState(doc.id);
        const state = store.getDocState(doc.id);
        const before = state?.content ?? doc.content;
        const found = before.match(re);
        if (!found || found.length === 0) continue;
        const next = before.replace(re, replacement);
        const op = opFromChange(before, next);
        const accepted = store.submitLocal(doc.id, op);
        if (!accepted) continue;
        files++;
        total += found.length;
        window.dispatchEvent(new CustomEvent("iw-doc-reset", { detail: { docId: doc.id } }));
      }
      toast(
        total
          ? `Replaced ${total} occurrence${total === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`
          : "Nothing to replace",
        total ? "success" : "info"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#1c1015] border-b border-[#43272e]">
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-[#43272e] flex-none">
        <Search size={13} className="text-[#c3a596]" />
        <input
          ref={inputRef}
          className="flex-1 bg-transparent outline-none text-xs text-[#fbeeda] placeholder-[#a1847a]"
          placeholder="Search in files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="flex items-center gap-1 text-[10px] text-[#c3a596] cursor-pointer">
          <input
            type="checkbox"
            className="accent-amber-500"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          Aa
        </label>
        <button
          className={`p-1 rounded hover:bg-[#332026] ${showReplace ? "text-amber-400" : "text-[#c3a596]"}`}
          onClick={() => setShowReplace((v) => !v)}
          title="Toggle find & replace"
        >
          <Replace size={13} />
        </button>
        <button
          className="p-1 rounded hover:bg-[#332026] text-[#c3a596]"
          onClick={onClose}
          aria-label="Close search"
        >
          <X size={13} />
        </button>
      </div>

      {showReplace && (
        <div className="flex items-center gap-2 px-2.5 py-2 border-b border-[#43272e] flex-none bg-[#1a0f13]">
          <input
            className="flex-1 bg-transparent outline-none text-xs text-[#fbeeda] placeholder-[#a1847a]"
            placeholder="Replace with…"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
          <span className="text-[10px] text-[#a1847a]">{totalHits} hits</span>
          <button
            className="btn btn-primary px-2.5 py-1 text-[11px]"
            onClick={replaceAll}
            disabled={busy || query.trim().length < 2 || totalHits === 0}
          >
            Replace all
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto py-1">
        {query.trim().length < 2 ? (
          <div className="px-3 py-3 text-[11px] text-[#a1847a]">Type at least two characters.</div>
        ) : results.matches.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-[#a1847a]">No matches.</div>
        ) : (
          <>
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[#a1847a]">
              {results.matches.length}
              {results.truncated ? "+" : ""} results in {results.files} file{results.files === 1 ? "" : "s"}
            </div>
            {results.matches.map((m, i) => (
              <button
                key={`${m.docId}-${m.line}-${i}`}
                className="w-full text-left px-3 py-1.5 hover:bg-[#2a181d] flex items-start gap-2"
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("iw-reveal-line", { detail: { docId: m.docId, line: m.line } })
                  );
                }}
              >
                <FileIcon size={12} className="text-[#c3a596] mt-0.5 flex-none" />
                <span className="min-w-0">
                  <span className="block truncate text-[10px] text-[#c3a596]">
                    {m.path}:{m.line}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-[#f3ddc9]">{m.text}</span>
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
