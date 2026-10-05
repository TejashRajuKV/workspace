"use client";

// Workspace layout: top bar, board (tool rail + canvas), code panel
// (explorer + editor), terminal, history slide-over. Resizable divider;
// tabbed layout on small screens.

import { useEffect, useRef, useState, useCallback } from "react";
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
import { toast } from "./Feedback";

export default function WorkspaceView() {
  const workspaceId = useSession((s) => s.workspaceId);
  const bootstrap = useSession((s) => s.bootstrap);
  const closeWorkspace = useSession((s) => s.closeWorkspace);
  const [showHistory, setShowHistory] = useState(false);
  const [showExplorer, setShowExplorer] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [codeWidth, setCodeWidth] = useState(460);
  const [mobileTab, setMobileTab] = useState("board"); // board | code | terminal
  const dragRef = useRef(null);
  const joinedRef = useRef(false);

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
          toast("Could not join workspace: " + res.error, "error");
          closeWorkspace();
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
  }, [workspaceId, bootstrap, closeWorkspace]);

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

  // ---- divider drag ----
  const startDrag = (e) => {
    dragRef.current = { startX: e.clientX, startW: codeWidth };
    const onMove = (ev) => {
      if (!dragRef.current) return;
      const w = dragRef.current.startW - (ev.clientX - dragRef.current.startX);
      setCodeWidth(Math.min(Math.max(w, 320), window.innerWidth - 380));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (!workspaceId || !bootstrap) return null;

  const codePanel = (
    <div className="flex h-full min-h-0" style={{ width: codeWidth }}>
      {showExplorer ? (
        <div className="w-48 flex-none">
          <FileExplorer workspaceId={workspaceId} />
        </div>
      ) : null}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-8 flex items-center gap-1 px-2 border-b border-[#232b3b] bg-[#0d1119] flex-none">
          <button
            className="p-1 rounded hover:bg-[#1b2230] text-[#8b94a7]"
            title={showExplorer ? "Hide file tree" : "Show file tree"}
            onClick={() => setShowExplorer(!showExplorer)}
          >
            <PanelRightClose size={14} className={showExplorer ? "" : "rotate-180"} />
          </button>
          <span className="text-[11px] text-[#8b94a7]">Code</span>
        </div>
        <div className="flex-1 min-h-0">
          <CodePanel />
        </div>
      </div>
    </div>
  );

  return (
    <div className="h-screen flex flex-col bg-[#0b0e14] overflow-hidden">
      <TopBar onToggleHistory={() => setShowHistory(!showHistory)} />

      <div className="flex-1 flex min-h-0 max-lg:flex-col">
        {/* board */}
        <div className={`${mobileTab === "board" ? "flex" : "hidden max-lg:hidden"} lg:flex flex-1 min-w-0 relative`}>
          <Toolbar />
          <CanvasBoard />
        </div>

        {/* divider */}
        <div
          className="w-1 cursor-col-resize bg-[#232b3b] hover:bg-emerald-600 transition-colors flex-none hidden lg:block"
          onPointerDown={startDrag}
        />

        {/* code panel */}
        <div className={`${mobileTab === "code" ? "flex" : "hidden max-lg:hidden"} lg:flex flex-col min-h-0 max-lg:flex-1 max-lg:w-full`}>
          {codePanel}
        </div>

        {showHistory && <HistoryPanel workspaceId={workspaceId} onClose={() => setShowHistory(false)} />}
      </div>

      {/* terminal */}
      <div className={`${mobileTab === "terminal" ? "block" : "hidden max-lg:hidden"} lg:block h-52 flex-none`}>
        <Terminal workspaceId={workspaceId} />
      </div>

      {/* mobile tab switcher */}
      <nav className="lg:hidden flex border-t border-[#232b3b] bg-[#0b0e14] flex-none">
        {[
          ["board", "Board", PenTool],
          ["code", "Code", SquareCode],
          ["terminal", "Terminal", PanelBottom],
        ].map(([id, label, Icon]) => (
          <button
            key={id}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] ${
              mobileTab === id ? "text-emerald-400" : "text-[#8b94a7]"
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
