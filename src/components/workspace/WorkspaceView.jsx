"use client";

// Workspace layout: top bar, board (tool rail + canvas), code panel
// (explorer + editor), terminal, history slide-over.
//
// The board/code and board/terminal boundaries are draggable so the user picks
// how much room each pane gets. Sizes and collapsed state persist per browser.

import { useEffect, useRef, useState } from "react";
import { PanelBottom, PanelRightClose, SquareCode, PenTool } from "lucide-react";
import { useBoard, boardRefs, flushPending } from "@/state/board";
import { useCode, bindDocSocket, resyncDoc } from "@/state/code";
import { useSession } from "@/state/session";
import { getSocket, on, emitAck, onLocal } from "@/lib/socket";
import CanvasBoard from "./CanvasBoard";
import Toolbar from "./Toolbar";
import TopBar from "./TopBar";
import FileExplorer from "./FileExplorer";
import CodePanel from "./CodePanel";
import Terminal from "./Terminal";
import HistoryPanel from "./HistoryPanel";
import CommentsPanel from "./CommentsPanel";
import LayersPanel from "./LayersPanel";
import GithubDialog from "./GithubDialog";
import ShareDialog from "./ShareDialog";
import ShortcutsDialog from "./ShortcutsDialog";
import AutomationDialog from "./AutomationDialog";
import TrashDialog from "./TrashDialog";
import AnalyticsDialog from "./AnalyticsDialog";
import TemplatesDialog from "./TemplatesDialog";
import CommandPalette from "./CommandPalette";
import { toast } from "./Feedback";

const LAYOUT_KEY = "iw.workspace.layout.v1";
const DEFAULT_CODE_WIDTH = 460;
const DEFAULT_TERMINAL_HEIGHT = 208;
const MIN_CODE_WIDTH = 280;
const MIN_TERMINAL_HEIGHT = 96;

function readLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      return {
        codeWidth: clamp(Number(v.codeWidth) || DEFAULT_CODE_WIDTH, MIN_CODE_WIDTH, 1600),
        terminalHeight: clamp(Number(v.terminalHeight) || DEFAULT_TERMINAL_HEIGHT, MIN_TERMINAL_HEIGHT, 1200),
        codeOpen: v.codeOpen !== false,
        terminalOpen: v.terminalOpen !== false,
      };
    }
  } catch {}
  return {
    codeWidth: DEFAULT_CODE_WIDTH,
    terminalHeight: DEFAULT_TERMINAL_HEIGHT,
    codeOpen: true,
    terminalOpen: true,
  };
}

function clamp(v, min, max) {
  return Math.round(Math.min(Math.max(v, min), max));
}

export default function WorkspaceView() {
  const workspaceId = useSession((s) => s.workspaceId);
  const bootstrap = useSession((s) => s.bootstrap);
  const [showHistory, setShowHistory] = useState(false);
  const [showGithub, setShowGithub] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAutomation, setShowAutomation] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showExplorer, setShowExplorer] = useState(() => window.innerWidth >= 768);
  const [showLayers, setShowLayers] = useState(false);
  const [mobileTab, setMobileTab] = useState("board"); // board | code | terminal
  const commentsOpen = useBoard((s) => s.commentsOpen);
  const closeComments = useBoard((s) => s.closeComments);
  const [layout, setLayout] = useState(readLayout);
  const { codeWidth, terminalHeight, codeOpen, terminalOpen } = layout;
  const joinedRef = useRef(false);

  const setPane = (key, value) =>
    setLayout((l) => ({ ...l, [key]: typeof value === "function" ? value(l[key]) : value }));

  // a collapsed pane can never be the active mobile tab
  const activeTab =
    (mobileTab === "code" && !codeOpen) || (mobileTab === "terminal" && !terminalOpen)
      ? "board"
      : mobileTab;

  // ---- persist layout ----
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {}
  }, [layout]);

  // never let a saved pane size overflow a smaller window
  useEffect(() => {
    const onResize = () => {
      setLayout((l) => ({
        ...l,
        codeWidth: clamp(l.codeWidth, MIN_CODE_WIDTH, Math.max(MIN_CODE_WIDTH, window.innerWidth - 320)),
        terminalHeight: clamp(
          l.terminalHeight,
          MIN_TERMINAL_HEIGHT,
          Math.max(MIN_TERMINAL_HEIGHT, window.innerHeight - 260)
        ),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ---- join the room + wire sockets ----
  useEffect(() => {
    if (!workspaceId || !bootstrap) return;
    const socket = getSocket();
    bindDocSocket();
    if (!joinedRef.current) {
      joinedRef.current = true;
      useBoard.getState().joined({
        objects: [],
        version: 0,
        role: bootstrap.role,
        me: bootstrap.me,
        members: bootstrap.members,
        peers: [],
      });
      useBoard.setState({ wsId: workspaceId });
      useCode.getState().setDocs(bootstrap.docs || []);
      emitAck("ws:join", { workspaceId }, 12000).then((res) => {
        if (res.error) {
          // REST bootstrap already proved membership, so a failed room join is
          // a transport problem — stay open and let board.js re-join on its
          // own once the socket reconnects, rather than kicking the user out.
          toast("Realtime unavailable — working offline: " + res.error, "error", 6000);
          return;
        }
        useBoard.getState().joined(res);
        useCode.getState().setDocs(res.docs || []);
        // open the first editable file if the tree is non-empty
        const first = (res.docs || []).find((d) => !d.isFolder);
        if (first && !useCode.getState().openTabs.length) useCode.getState().openDoc(first.id);
      });
    }

    const offFs = on("fs:changed", async () => {
      const res = await fetch(`/api/workspaces/${workspaceId}/bootstrap`);
      if (res.ok) {
        const data = await res.json();
        useCode.getState().setDocs(data.docs || []);
      }
    });

    const offRestored = on("ws:restored", ({ toVersion, by }) => {
      toast(`Board restored to v${toVersion} by ${by}`, "success");
    });

    const offReset = (evt) => {
      toast("A document was reset by resync — unsent local edits could not be merged.", "error", 6000);
    };
    window.addEventListener("iw-doc-reset", offReset);
    const offToast = (evt) => {
      toast(evt.detail?.msg || "");
    };
    window.addEventListener("iw-toast", offToast);

    // keep trying to flush the offline queue when we come back online
    const offConn = onLocal("connection", (state) => {
      if (state === "online") flushPending();
    });

    return () => {
      offFs();
      offRestored();
      window.removeEventListener("iw-doc-reset", offReset);
      window.removeEventListener("iw-toast", offToast);
      offConn();
    };
  }, [workspaceId, bootstrap]);

  // ---- layer panel shortcut (Ctrl+Shift+L, emitted by the canvas engine) ----
  useEffect(() => {
    const onLayers = () => setShowLayers((v) => !v);
    window.addEventListener("iw-toggle-layers", onLayers);
    return () => window.removeEventListener("iw-toggle-layers", onLayers);
  }, []);

  // ---- leave room on unmount ----
  useEffect(() => {
    return () => {
      if (joinedRef.current) {
        joinedRef.current = false;
        try {
          getSocket().emit("ws:leave");
        } catch {}
        useBoard.getState().reset();
        useBoard.setState({ wsId: null });
      }
    };
  }, []);

  // ---- draggable dividers ----
  const dragCode = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = codeWidth;
    document.body.classList.add("resizing-col");
    const onMove = (ev) => {
      const max = Math.max(MIN_CODE_WIDTH, window.innerWidth - 320);
      setPane("codeWidth", clamp(startW - (ev.clientX - startX), MIN_CODE_WIDTH, max));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing-col");
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const dragTerminal = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = terminalHeight;
    document.body.classList.add("resizing-row");
    const onMove = (ev) => {
      const max = Math.max(MIN_TERMINAL_HEIGHT, window.innerHeight - 260);
      setPane("terminalHeight", clamp(startH - (ev.clientY - startY), MIN_TERMINAL_HEIGHT, max));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing-row");
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  if (!workspaceId || !bootstrap) return null;

  const reloadWorkspace = async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/bootstrap`);
    if (!res.ok) return;
    const data = await res.json();
    useSession.setState({ bootstrap: data, role: data.role });
    useCode.getState().setDocs(data.docs || []);
    useBoard.setState({ role: data.role, members: data.members || [] });
  };

  const codePanel = (
    <div className="flex h-full min-h-0 w-full">
      {showExplorer ? (
        <div className="w-48 flex-none">
          <FileExplorer workspaceId={workspaceId} />
        </div>
      ) : null}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-8 flex items-center gap-1 px-2 border-b border-[#43272e] bg-[#1c1015] flex-none">
          <button
            className="p-1 rounded hover:bg-[#332026] text-[#c3a596]"
            title={showExplorer ? "Hide file tree" : "Show file tree"}
            onClick={() => setShowExplorer(!showExplorer)}
          >
            <PanelRightClose size={14} className={showExplorer ? "" : "rotate-180"} />
          </button>
          <span className="text-[11px] text-[#c3a596]">Code</span>
        </div>
        <div className="flex-1 min-h-0">
          <CodePanel />
        </div>
      </div>
    </div>
  );

  const codeVisibility = codeOpen
    ? `${activeTab === "code" ? "flex" : "hidden max-lg:hidden"} lg:flex`
    : "hidden";
  const terminalVisibility = terminalOpen
    ? `${activeTab === "terminal" ? "block" : "hidden max-lg:hidden"} lg:block`
    : "hidden";

  const tabs = [
    ["board", "Board", PenTool, true],
    ["code", "Code", SquareCode, codeOpen],
    ["terminal", "Terminal", PanelBottom, terminalOpen],
  ].filter(([, , , enabled]) => enabled);

  return (
    <div className="h-screen flex flex-col bg-[#170d12] overflow-hidden">
      <TopBar
        onToggleHistory={() => setShowHistory(!showHistory)}
        onOpenGithub={() => setShowGithub(true)}
        onOpenShare={() => setShowShare(true)}
        onOpenShortcuts={() => setShowShortcuts(true)}
        onOpenAutomation={() => setShowAutomation(true)}
        onOpenAnalytics={() => setShowAnalytics(true)}
        onOpenTemplates={() => setShowTemplates(true)}
        onOpenTrash={() => setShowTrash(true)}
        onOpenLayers={() => setShowLayers((v) => !v)}
        layersOpen={showLayers}
        codeOpen={codeOpen}
        terminalOpen={terminalOpen}
        onToggleCode={() => setPane("codeOpen", (v) => !v)}
        onToggleTerminal={() => setPane("terminalOpen", (v) => !v)}
      />

      <div
        className={`flex-1 flex min-h-0 max-lg:flex-col ${
          activeTab === "terminal" ? "max-lg:hidden" : ""
        }`}
      >
        {/* board */}
        <div className={`${activeTab === "board" ? "flex" : "hidden max-lg:hidden"} lg:flex flex-1 min-w-0 relative`}>
          <Toolbar />
          <CanvasBoard />
        </div>

        {/* layers panel — a sibling of the board so the floating toolbar cannot
            overlap it */}
        {showLayers && <LayersPanel onClose={() => setShowLayers(false)} />}

        {/* vertical divider — drag to choose board vs code width */}
        {codeOpen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize code panel"
            title="Drag to resize · double-click to reset"
            onPointerDown={dragCode}
            onDoubleClick={() => setPane("codeWidth", DEFAULT_CODE_WIDTH)}
            className="group z-20 hidden lg:flex w-1.5 -mx-0.5 cursor-col-resize items-center justify-center hover:bg-amber-500/20 transition-colors"
          >
            <span className="h-8 w-0.5 rounded-full bg-[#43272e] group-hover:bg-amber-400" />
          </div>
        )}

        {/* code panel */}
        <div
          className={`${codeVisibility} flex-col min-h-0 max-lg:flex-1 max-lg:w-full lg:w-[var(--code-width)] lg:flex-none`}
          style={{ "--code-width": `${codeWidth}px` }}
        >
          {codePanel}
        </div>

        {showHistory && <HistoryPanel workspaceId={workspaceId} onClose={() => setShowHistory(false)} />}
        {commentsOpen && <CommentsPanel workspaceId={workspaceId} onClose={closeComments} />}
      </div>

      {/* horizontal divider — drag to choose board vs terminal height */}
      {terminalOpen && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          title="Drag to resize · double-click to reset"
          onPointerDown={dragTerminal}
          onDoubleClick={() => setPane("terminalHeight", DEFAULT_TERMINAL_HEIGHT)}
          className="group z-20 hidden lg:flex h-1.5 -my-0.5 cursor-row-resize items-center justify-center hover:bg-amber-500/20 transition-colors"
        >
          <span className="w-10 h-0.5 rounded-full bg-[#43272e] group-hover:bg-amber-400" />
        </div>
      )}

      {/* terminal */}
      <div
        className={`${terminalVisibility} min-h-0 max-lg:flex-1 lg:flex-none lg:h-[var(--terminal-h)]`}
        style={{ "--terminal-h": `${terminalHeight}px` }}
      >
        <Terminal workspaceId={workspaceId} />
      </div>

      {/* mobile tab switcher */}
      <GithubDialog
        workspaceId={workspaceId}
        open={showGithub}
        onClose={() => setShowGithub(false)}
      />
      <ShareDialog
        workspaceId={workspaceId}
        open={showShare}
        onClose={() => setShowShare(false)}
        onChanged={reloadWorkspace}
      />
      <ShortcutsDialog open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <AutomationDialog
        workspaceId={workspaceId}
        open={showAutomation}
        onClose={() => setShowAutomation(false)}
      />
      <TrashDialog
        workspaceId={workspaceId}
        open={showTrash}
        onClose={() => setShowTrash(false)}
        onChanged={reloadWorkspace}
      />
      <AnalyticsDialog
        workspaceId={workspaceId}
        open={showAnalytics}
        onClose={() => setShowAnalytics(false)}
      />
      <TemplatesDialog
        workspaceId={workspaceId}
        open={showTemplates}
        onClose={() => setShowTemplates(false)}
      />
      <CommandPalette
        workspaceId={workspaceId}
        onOpenGithub={() => setShowGithub(true)}
        onOpenShare={() => setShowShare(true)}
        onOpenHistory={() => setShowHistory(true)}
        onOpenShortcuts={() => setShowShortcuts(true)}
        onOpenAutomation={() => setShowAutomation(true)}
        onOpenTrash={() => setShowTrash(true)}
        onOpenAnalytics={() => setShowAnalytics(true)}
        onOpenTemplates={() => setShowTemplates(true)}
        onOpenLayers={() => setShowLayers((v) => !v)}
      />

      <nav className="lg:hidden flex border-t border-[#43272e] bg-[#170d12] flex-none">
        {tabs.map(([id, label, Icon]) => (
          <button
            key={id}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] ${
              activeTab === id ? "text-amber-400" : "text-[#c3a596]"
            }`}
            onClick={() => setMobileTab(id)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
