"use client";

// Single-page application root. The preview gateway exposes exactly one
// route, so auth → dashboard → workspace are internal view states.

import { useEffect } from "react";
import { useSession } from "@/state/session";
import { useBoard } from "@/state/board";
import { useCode } from "@/state/code";
import { getSocket, onLocal } from "@/lib/socket";
import { bindBoardSocket, boardRefs } from "@/state/board";
import AuthView from "@/components/workspace/AuthView";
import DashboardView from "@/components/workspace/DashboardView";
import WorkspaceView from "@/components/workspace/WorkspaceView";

export default function Page() {
  const view = useSession((s) => s.view);
  const setUser = useSession((s) => s.setUser);

  useEffect(() => {
    // bind the realtime layer once
    bindBoardSocket();
    // e2e/debug hooks
    try {
      window.__iwStores = { session: useSession, board: useBoard, code: useCode, refs: boardRefs };
    } catch {}

    let alive = true;
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        if (data.user) {
          setUser(data.user);
          // the socket may have been rejected before the session existed
          try {
            const s = getSocket();
            if (s.disconnected) s.connect();
          } catch {}
          // deep link: /?w=<workspaceId> restores the workspace after a
          // reload instead of dumping the user back on the dashboard
          const wid = new URLSearchParams(window.location.search).get("w");
          if (wid) openWorkspace(wid);
        } else {
          useSession.setState({ view: "auth" });
        }
      })
      .catch(() => alive && useSession.setState({ view: "auth" }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setUser]);

  const openWorkspace = async (workspaceId) => {
    // make sure the realtime socket is live (it may have been rejected
    // before login — socket.io does not always retry after auth failures)
    try {
      const s = getSocket();
      if (s.disconnected) s.connect();
    } catch {}
    // join by ID first (idempotent — creators keep their owner role)
    await fetch(`/api/workspaces/${workspaceId}/join`, { method: "POST" }).catch(() => {});
    const res = await fetch(`/api/workspaces/${workspaceId}/bootstrap`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Could not open workspace");
      return;
    }
    const bootstrap = await res.json();
    useSession.getState().openWorkspace(workspaceId, bootstrap);
    // reflect the open workspace in the URL so a reload restores it
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("w", workspaceId);
      window.history.replaceState(null, "", url);
    } catch {}
  };

  if (view === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0b0e14] text-[#8b94a7] text-sm">
        Loading…
      </div>
    );
  }
  if (view === "auth") return <AuthView onAuthed={(user) => setUser(user)} />;
  if (view === "workspace") return <WorkspaceView />;
  return <DashboardView onOpen={openWorkspace} />;
}
