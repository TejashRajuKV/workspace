"use client";

// Top bar: workspace identity, connection state, live presence avatars,
// history toggle, run shortcut, mobile view tabs.

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  Bell,
  Copy,
  Download,
  Ellipsis,
  FileJson,
  FileText,
  Github,
  History,
  Image as ImageIcon,
  Keyboard,
  Layers,
  LayoutTemplate,
  MessageSquare,
  PanelBottom,
  PanelRight,
  Play,
  Share2,
  Trash,
  Upload,
  Wifi,
  WifiOff,
  Users,
  Zap,
} from "lucide-react";
import { useBoard } from "@/state/board";
import { useCode } from "@/state/code";
import { useSession } from "@/state/session";
import { useNotifications } from "@/state/notifications";
import { getSocket, emitAck } from "@/lib/socket";
import { toast } from "./Feedback";
import { exportBoardJSON, exportBoardPDF, exportBoardPNG } from "./canvas-engine/exportBoard";
import { importCanvasObjects } from "./canvas-engine/importCanvas";
import NotificationsPanel from "./NotificationsPanel";

export default function TopBar({
  onToggleHistory,
  onOpenGithub,
  onOpenShare,
  onOpenShortcuts,
  onOpenAutomation,
  onOpenAnalytics,
  onOpenTemplates,
  onOpenTrash,
  onOpenLayers,
  layersOpen,
  codeOpen,
  terminalOpen,
  onToggleCode,
  onToggleTerminal,
}) {
  const members = useBoard((s) => s.members);
  const me = useBoard((s) => s.me);
  const peerCount = useBoard((s) => s.peerCount);
  const onlineUsers = useBoard((s) => s.onlineUsers);
  const connection = useBoard((s) => s.connection);
  const lastVersion = useBoard((s) => s.lastVersion);
  const workspaceId = useBoard((s) => s.wsId);
  const activeDocId = useCode((s) => s.activeDocId);
  const closeWorkspace = useSession((s) => s.closeWorkspace);
  const bootstrap = useSession((s) => s.bootstrap);
  const role = useBoard((s) => s.role);
  const [running, setRunning] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const canvasImportRef = useRef(null);
  const workspaceName = bootstrap?.workspace?.name;
  const unread = useNotifications((s) => s.unread);
  const commentsOpen = useBoard((s) => s.commentsOpen);
  const toggleComments = useBoard((s) => s.toggleComments);
  const presenceByUser = useBoard((s) => s.presenceByUser);

  useEffect(() => {
    const close = () => {
      setExportOpen(false);
      setMoreOpen(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  // invoke a dialog opener and dismiss the overflow menu
  const run = (fn) => {
    setMoreOpen(false);
    fn?.();
  };

  const runExport = async (kind) => {
    setExportOpen(false);
    try {
      if (kind === "png") await exportBoardPNG(workspaceName);
      else if (kind === "pdf") await exportBoardPDF(workspaceName);
      else if (kind === "json") exportBoardJSON(workspaceName);
    } catch (err) {
      toast(String(err.message || err), "error");
    }
  };

  const copyWorkspaceId = async () => {
    if (!workspaceId) return;
    try {
      await navigator.clipboard.writeText(workspaceId);
      toast("Workspace ID copied", "success");
    } catch {
      toast(workspaceId, "info", 8000);
    }
  };

  const runActive = async () => {
    if (!activeDocId || running) return;
    setRunning(true);
    try {
      await emitAck("exec:start", { fileId: activeDocId, language: null }, 6000);
    } catch {}
    setTimeout(() => setRunning(false), 1200);
  };

  // everyone who belongs to the workspace, plus anyone present who joined
  // after we opened it (bootstrap members are a snapshot); offline dimmed
  const onlineIds = new Set(onlineUsers.map((u) => u.id));
  const everyone = [...members];
  for (const u of onlineUsers) {
    if (!everyone.some((m) => m.user.id === u.id)) everyone.push({ user: u, role: "editor" });
  }
  everyone.sort((a, b) => Number(onlineIds.has(b.user.id)) - Number(onlineIds.has(a.user.id)));
  const avatarStack = everyone.slice(0, 6);

  return (
    <header className="h-12 flex items-center gap-2 px-3 border-b border-[#43272e] bg-[#170d12] flex-none">
      <button
        className="p-1.5 rounded-md hover:bg-[#332026] text-[#c3a596] hover:text-white"
        title="Back to dashboard"
        onClick={() => {
          try {
            getSocket().emit("ws:leave");
          } catch {}
          closeWorkspace();
        }}
      >
        <ArrowLeft size={17} />
      </button>
      <div className="min-w-0">
        <h1 className="text-sm font-semibold truncate max-w-40 sm:max-w-56 text-[#fbeeda]">
          {bootstrap?.workspace?.name || "Workspace"}
        </h1>
      </div>
      <span
        className={`ml-1 max-md:hidden px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${
          role === "owner"
            ? "bg-amber-500/15 text-amber-400"
            : role === "editor"
              ? "bg-orange-500/15 text-orange-300"
              : "bg-stone-500/15 text-stone-400"
        }`}
      >
        {role}
      </span>

      <button
        onClick={copyWorkspaceId}
        className="ml-1 max-lg:hidden flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#332026] border border-[#43272e] text-[10px] font-mono text-[#c3a596] hover:text-white hover:border-[#553038]"
        title={`Workspace ID: ${workspaceId} — click to copy`}
      >
        <span className="max-w-20 sm:max-w-40 truncate">{workspaceId}</span>
        <Copy size={10} className="flex-none" />
      </button>

      <span
        className="flex items-center gap-1 text-[11px] text-[#c3a596] ml-2"
        title={`synced to operation v${lastVersion}`}
      >
        {connection === "online" ? (
          <Wifi size={13} className="text-amber-400" />
        ) : (
          <WifiOff size={13} className="text-amber-400" />
        )}
        <span className="hidden sm:inline">v{lastVersion}</span>
      </span>

      <div className="flex-1" />

      <div className="hidden md:block">
        <button
          onClick={runActive}
          disabled={running || !activeDocId || role === "viewer"}
          className="btn btn-primary px-3 py-1.5"
          title="Run the active file"
        >
          <Play size={13} /> Run
        </button>
      </div>
      <div className="hidden md:flex items-center gap-1">
        <button
          onClick={onToggleCode}
          title={codeOpen ? "Hide code panel" : "Show code panel"}
          className={`btn btn-ghost px-2 py-1.5 ${codeOpen ? "text-amber-400" : "text-[#c3a596]"}`}
        >
          <PanelRight size={15} />
        </button>
        <button
          onClick={onToggleTerminal}
          title={terminalOpen ? "Hide terminal" : "Show terminal"}
          className={`btn btn-ghost px-2 py-1.5 ${terminalOpen ? "text-amber-400" : "text-[#c3a596]"}`}
        >
          <PanelBottom size={15} />
        </button>
      </div>
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => setExportOpen((v) => !v)}
          className="btn btn-ghost px-2.5 py-1.5"
          title="Export board"
        >
          <Download size={15} /> <span className="hidden xl:inline text-xs">Export</span>
        </button>
        {exportOpen && (
          <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-md border border-[#43272e] bg-[#2a181d] shadow-xl py-1 text-xs">
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
              onClick={() => runExport("png")}
            >
              <ImageIcon size={12} /> Board as PNG
            </button>
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
              onClick={() => runExport("pdf")}
            >
              <FileText size={12} /> Board as PDF
            </button>
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
              onClick={() => runExport("json")}
            >
              <FileJson size={12} /> Board as JSON
            </button>
            {role !== "viewer" && (
              <>
                <div className="my-1 h-px bg-[#43272e]" />
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                  onClick={() => {
                    setExportOpen(false);
                    canvasImportRef.current?.click();
                  }}
                >
                  <Upload size={12} /> Import board JSON
                </button>
              </>
            )}
          </div>
        )}
        <input
          ref={canvasImportRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              const parsed = JSON.parse(await f.text());
              const objects = Array.isArray(parsed) ? parsed : parsed.objects;
              if (!Array.isArray(objects)) throw new Error("This file has no board objects");
              const res = importCanvasObjects(objects);
              toast(
                res.reason ? res.reason : `Imported ${res.added} object${res.added === 1 ? "" : "s"}`,
                res.added ? "success" : "error"
              );
            } catch (err) {
              toast(String(err.message || err), "error");
            }
          }}
        />
      </div>
      <button
        onClick={onOpenShare}
        className="btn btn-ghost px-2.5 py-1.5"
        title="Share workspace"
      >
        <Share2 size={15} /> <span className="hidden xl:inline text-xs">Share</span>
      </button>
      <button
        onClick={onOpenGithub}
        className="btn btn-ghost px-2.5 py-1.5"
        title="GitHub sync"
      >
        <Github size={15} /> <span className="hidden xl:inline text-xs">GitHub</span>
      </button>
      <button
        onClick={onToggleHistory}
        className="btn btn-ghost px-2.5 py-1.5"
        title="Version history"
      >
        <History size={15} /> <span className="hidden lg:inline text-xs">History</span>
      </button>
      <button
        onClick={toggleComments}
        className={`btn btn-ghost px-2.5 py-1.5 ${commentsOpen ? "text-amber-400" : ""}`}
        title={commentsOpen ? "Hide comments" : "Show comments"}
      >
        <MessageSquare size={15} />
      </button>
      <button
        onClick={onOpenShortcuts}
        className="btn btn-ghost px-2 py-1.5 max-lg:hidden"
        title="Keyboard shortcuts"
      >
        <Keyboard size={15} />
      </button>
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => setNotifOpen((v) => !v)}
          className="btn btn-ghost px-2.5 py-1.5 relative"
          title="Notifications"
        >
          <Bell size={15} />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-amber-500 text-[9px] leading-4 text-[#2a1208] font-bold text-center">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
        <NotificationsPanel open={notifOpen} onClose={() => setNotifOpen(false)} />
      </div>

      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => setMoreOpen((v) => !v)}
          className="btn btn-ghost px-2 py-1.5"
          title="More tools"
        >
          <Ellipsis size={16} />
        </button>
        {moreOpen && (
          <div className="absolute right-0 top-full z-40 mt-1 w-52 rounded-xl border border-[#43272e] bg-[#201317] py-1 shadow-2xl">
            <MoreItem icon={Zap} label="Automation" onClick={() => run(onOpenAutomation)} />
            <MoreItem
              icon={Layers}
              label={layersOpen ? "Hide layers" : "Show layers"}
              onClick={() => run(onOpenLayers)}
            />
            <MoreItem icon={BarChart3} label="Analytics" onClick={() => run(onOpenAnalytics)} />
            <MoreItem icon={LayoutTemplate} label="Templates" onClick={() => run(onOpenTemplates)} />
            <MoreItem icon={Trash} label="Trash" onClick={() => run(onOpenTrash)} />
            <MoreItem icon={Keyboard} label="Shortcuts" onClick={() => run(onOpenShortcuts)} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 pl-1" title={`${peerCount} other${peerCount === 1 ? "" : "s"} online`}>
        <Users size={14} className="text-[#c3a596]" />
        <div className="flex -space-x-1.5">
          {avatarStack.map((m) => {
            const isMe = me && m.user.id === me.id;
            const presence = presenceByUser.get(m.user.id);
            const status = presence?.status || (onlineIds.has(m.user.id) ? "active" : "offline");
            const statusColor =
              status === "active" ? "#22c55e" : status === "idle" ? "#f59e0b" : status === "away" ? "#94a3b8" : "#57534e";
            const statusLabel = presence?.typing
              ? "typing…"
              : status === "offline"
                ? "offline"
                : status;
            return (
              <span key={m.user.id} className="relative inline-flex">
                <span
                  title={`${m.user.username}${isMe ? " (you)" : ""} · ${m.role} · ${statusLabel}`}
                  className="w-6 h-6 rounded-full border-2 border-[#170d12] flex items-center justify-center text-[10px] font-bold text-white"
                  style={{ background: m.user.color, opacity: status === "offline" ? 0.35 : 1 }}
                >
                  {m.user.username.slice(0, 2).toUpperCase()}
                </span>
                <span
                  className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-[#170d12]"
                  style={{ background: statusColor }}
                />
              </span>
            );
          })}
          {everyone.length > 6 && (
            <span className="w-6 h-6 rounded-full border-2 border-[#170d12] bg-[#332026] text-[9px] text-[#c3a596] flex items-center justify-center">
              +{everyone.length - 6}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

function MoreItem({ icon: Icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[#c3a596] hover:bg-[#332026] hover:text-[#fbeeda]"
    >
      <Icon size={13} /> {label}
    </button>
  );
}
