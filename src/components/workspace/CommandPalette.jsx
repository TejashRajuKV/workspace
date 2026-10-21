"use client";

// Command palette (Ctrl/Cmd+K): jump to files and run workspace actions.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Download,
  File as FileIcon,
  FileJson,
  FileText,
  Github,
  History,
  Image as ImageIcon,
  Keyboard,
  Layers,
  LayoutTemplate,
  Play,
  Search,
  Share2,
  SquareCode,
  Trash,
  Zap,
} from "lucide-react";
import { useCode } from "@/state/code";
import { emitAck } from "@/lib/socket";
import { toast } from "./Feedback";
import { exportBoardJSON, exportBoardPDF, exportBoardPNG } from "./canvas-engine/exportBoard";

export default function CommandPalette({
  onOpenGithub,
  onOpenShare,
  onOpenHistory,
  onOpenShortcuts,
  onOpenAutomation,
  onOpenAnalytics,
  onOpenTemplates,
  onOpenTrash,
  onOpenLayers,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const docs = useCode((s) => s.docs);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setActive(0);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  const actions = useMemo(
    () => [
      {
        id: "run",
        label: "Run active file",
        icon: Play,
        run: async () => {
          const docId = useCode.getState().activeDocId;
          if (!docId) return toast("Open a file first", "error");
          try {
            await emitAck("exec:start", { fileId: docId, language: null }, 6000);
          } catch {
            toast("Could not start the run", "error");
          }
        },
      },
      { id: "history", label: "Open workspace history", icon: History, run: onOpenHistory },
      { id: "share", label: "Share workspace", icon: Share2, run: onOpenShare },
      { id: "github", label: "GitHub sync", icon: Github, run: onOpenGithub },
      { id: "automation", label: "Automation (webhooks, schedules, rules)", icon: Zap, run: onOpenAutomation },
      { id: "analytics", label: "Workspace analytics", icon: BarChart3, run: onOpenAnalytics },
      { id: "templates", label: "Workspace templates", icon: LayoutTemplate, run: onOpenTemplates },
      { id: "trash", label: "Open trash", icon: Trash, run: onOpenTrash },
      { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard, run: onOpenShortcuts },
      { id: "layers", label: "Toggle layers panel", icon: Layers, run: onOpenLayers },
      {
        id: "png",
        label: "Export board as PNG",
        icon: ImageIcon,
        run: () => exportBoardPNG(),
      },
      {
        id: "pdf",
        label: "Export board as PDF",
        icon: FileText,
        run: () => exportBoardPDF(),
      },
      {
        id: "json",
        label: "Export board as JSON",
        icon: FileJson,
        run: () => exportBoardJSON(),
      },
    ],
    [onOpenGithub, onOpenShare, onOpenHistory, onOpenShortcuts, onOpenAutomation, onOpenAnalytics, onOpenTemplates, onOpenTrash, onOpenLayers]
  );

  const q = query.trim().toLowerCase();
  const fileHits = useMemo(() => {
    if (!q) return docs.filter((d) => !d.isFolder).slice(0, 8);
    return docs
      .filter((d) => !d.isFolder && d.path.toLowerCase().includes(q))
      .slice(0, 12);
  }, [docs, q]);

  const actionHits = useMemo(
    () => (q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions),
    [actions, q]
  );

  const items = [
    ...fileHits.map((d) => ({ kind: "file", id: d.id, label: d.path, doc: d })),
    ...actionHits.map((a) => ({ kind: "action", id: a.id, label: a.label, icon: a.icon, run: a.run })),
  ];

  if (!open) return null;

  const choose = async (item) => {
    setOpen(false);
    if (!item) return;
    if (item.kind === "file") {
      useCode.getState().openDoc(item.id);
    } else {
      try {
        await item.run();
      } catch (err) {
        toast(String(err?.message || err), "error");
      }
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4 bg-black/55 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div className="w-full max-w-md rounded-xl border border-[#43272e] bg-[#201317] shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-[#43272e]">
          <Search size={15} className="text-[#c3a596]" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent outline-none text-sm text-[#fbeeda] placeholder-[#a1847a]"
            placeholder="Search files and actions…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <kbd className="rounded border border-[#43272e] px-1.5 py-0.5 text-[10px] text-[#a1847a]">Esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {items.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-[#c3a596]">No matches</div>
          )}
          {items.map((item, i) => {
            const Icon = item.kind === "file" ? FileIcon : item.icon || SquareCode;
            return (
              <button
                key={`${item.kind}-${item.id}`}
                className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-xs ${
                  i === active ? "bg-amber-500/15 text-[#fbeeda]" : "text-[#c3a596] hover:bg-[#2a181d]"
                }`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(item)}
              >
                <Icon size={13} className={item.kind === "file" ? "text-[#c3a596]" : "text-amber-400"} />
                <span className="truncate">{item.label}</span>
                {item.kind === "action" && <span className="ml-auto text-[10px] text-[#a1847a]">action</span>}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3 px-3.5 py-2 border-t border-[#43272e] text-[10px] text-[#a1847a]">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="ml-auto flex items-center gap-1">
            <Download size={10} /> exports included
          </span>
        </div>
      </div>
    </div>
  );
}
