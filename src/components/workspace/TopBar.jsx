"use client";

// Top bar: workspace identity, connection state, live presence avatars,
// history toggle, run shortcut, mobile view tabs.

import { useState } from "react";
import { ArrowLeft, History, Play, Wifi, WifiOff, Users } from "lucide-react";
import { useBoard } from "@/state/board";
import { useCode } from "@/state/code";
import { useSession } from "@/state/session";
import { getSocket, emitAck } from "@/lib/socket";

export default function TopBar({ onToggleHistory }) {
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
    <header className="h-12 flex items-center gap-2 px-3 border-b border-[#232b3b] bg-[#0b0e14] flex-none">
      <button
        className="p-1.5 rounded-md hover:bg-[#1b2230] text-[#8b94a7] hover:text-white"
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
        <h1 className="text-sm font-semibold truncate max-w-28 sm:max-w-48 text-[#e6e9ef]">
          {bootstrap?.workspace?.name || "Workspace"}
        </h1>
      </div>
      <span
        className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${
          role === "owner"
            ? "bg-emerald-500/15 text-emerald-400"
            : role === "editor"
              ? "bg-sky-500/15 text-sky-400"
              : "bg-slate-500/15 text-slate-400"
        }`}
      >
        {role}
      </span>

      <span
        className="flex items-center gap-1 text-[11px] text-[#8b94a7] ml-2"
        title={`synced to operation v${lastVersion}`}
      >
        {connection === "online" ? (
          <Wifi size={13} className="text-emerald-400" />
        ) : (
          <WifiOff size={13} className="text-amber-400" />
        )}
        <span className="hidden sm:inline">v{lastVersion}</span>
      </span>

      <div className="flex-1" />

      <button
        onClick={runActive}
        disabled={running || !activeDocId || role === "viewer"}
        className="btn btn-primary px-3 py-1.5 hidden md:inline-flex"
        title="Run the active file"
      >
        <Play size={13} /> Run
      </button>
      <button
        onClick={onToggleHistory}
        className="btn btn-ghost px-2.5 py-1.5"
        title="Version history"
      >
        <History size={15} /> <span className="hidden lg:inline text-xs">History</span>
      </button>

      <div className="flex items-center gap-1.5 pl-1" title={`${peerCount} other${peerCount === 1 ? "" : "s"} online`}>
        <Users size={14} className="text-[#8b94a7]" />
        <div className="flex -space-x-1.5">
          {avatarStack.map((m) => {
            const isMe = me && m.user.id === me.id;
            return (
              <span
                key={m.user.id}
                title={`${m.user.username}${isMe ? " (you)" : ""} · ${m.role}${isMe || onlineIds.has(m.user.id) ? "" : " · offline"}`}
                className="w-6 h-6 rounded-full border-2 border-[#0b0e14] flex items-center justify-center text-[10px] font-bold text-white"
                style={{ background: m.user.color, opacity: isMe || onlineIds.has(m.user.id) ? 1 : 0.35 }}
              >
                {m.user.username.slice(0, 2).toUpperCase()}
              </span>
            );
          })}
          {everyone.length > 6 && (
            <span className="w-6 h-6 rounded-full border-2 border-[#0b0e14] bg-[#1b2230] text-[9px] text-[#8b94a7] flex items-center justify-center">
              +{everyone.length - 6}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
