// Single-page application root. The preview gateway exposes exactly one
// route, so auth → dashboard → workspace are internal view states.

import { useEffect, useRef, useState } from "react";
import { useSession } from "@/state/session";
import { useBoard } from "@/state/board";
import { useCode } from "@/state/code";
import { useNotifications, bindNotifications } from "@/state/notifications";
import { getSocket, onLocal } from "@/lib/socket";
import { bindBoardSocket, boardRefs } from "@/state/board";
import AuthView from "@/components/workspace/AuthView";
import DashboardView from "@/components/workspace/DashboardView";
import WorkspaceView from "@/components/workspace/WorkspaceView";
import LandingView from "@/components/landing/LandingView";
import PublicShareView from "@/components/workspace/PublicShareView";
import FeedbackHost from "@/components/workspace/Feedback";

export default function App() {
  const view = useSession((s) => s.view);
  const setUser = useSession((s) => s.setUser);
  const [authMode, setAuthMode] = useState("login");
  const [shareToken] = useState(() => new URLSearchParams(window.location.search).get("s"));
  const pendingInviteRef = useRef(new URLSearchParams(window.location.search).get("invite"));
  const openWorkspaceRef = useRef(null);

  const goAuth = (mode) => {
    setAuthMode(mode);
    useSession.setState({ view: "auth" });
  };
  const goLanding = () => useSession.setState({ view: "landing" });

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

  useEffect(() => {
    openWorkspaceRef.current = openWorkspace;
  });

  const acceptInvite = async () => {
    const code = pendingInviteRef.current;
    if (!code) return false;
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(code)}/accept`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "This invite could not be used");
        return false;
      }
      pendingInviteRef.current = null;
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("invite");
        window.history.replaceState(null, "", url);
      } catch {}
      await openWorkspace(data.workspaceId);
      return true;
    } catch {
      alert("Could not reach the server to accept the invite");
      return false;
    }
  };

  useEffect(() => {
    // public share links are read-only and need no session or socket
    if (shareToken) return;
    // bind the realtime layer once
    bindBoardSocket();
    bindNotifications();
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
          useNotifications.getState().load();
          // the socket may have been rejected before the session existed
          try {
            const s = getSocket();
            if (s.disconnected) s.connect();
          } catch {}
          // deep link: /?w=<workspaceId> restores the workspace after a
          // reload instead of dumping the user back on the dashboard
          const wid = new URLSearchParams(window.location.search).get("w");
          if (pendingInviteRef.current) acceptInvite();
          else if (wid) openWorkspace(wid);
        } else {
          useSession.setState({ view: "landing" });
        }
      })
      .catch(() => alive && useSession.setState({ view: "landing" }));
    return () => {
      alive = false;
    };
  }, [setUser, shareToken]);

  // deep-link from a notification (bell or OS) → open the workspace and,
  // when the notification points at a board object, focus its comment thread
  useEffect(() => {
    const onOpen = async (evt) => {
      const { id, objectId } = evt.detail || {};
      if (!id) return;
      await openWorkspaceRef.current?.(id);
      if (objectId) useBoard.getState().openComment(objectId);
    };
    window.addEventListener("iw-open-workspace", onOpen);
    return () => window.removeEventListener("iw-open-workspace", onOpen);
  }, []);

  let content;
  if (shareToken) {
    content = <PublicShareView token={shareToken} />;
  } else if (view === "loading") {
    content = (
      <div className="min-h-screen flex items-center justify-center bg-[#170d12] text-[#c3a596] text-sm">
        Loading…
      </div>
    );
  } else if (view === "landing") {
    content = <LandingView onStart={() => goAuth("register")} onSignIn={() => goAuth("login")} />;
  } else if (view === "auth") {
    content = (
      <AuthView
        initialMode={authMode}
        onBack={goLanding}
        onAuthed={(user) => {
          setUser(user);
          useNotifications.getState().load();
          if (pendingInviteRef.current) acceptInvite();
        }}
      />
    );
  } else if (view === "workspace") {
    content = <WorkspaceView />;
  } else {
    content = <DashboardView onOpen={openWorkspace} />;
  }

  // The dialog/toast host must live above every view, otherwise promptDialog()
  // and confirmDialog() never render and their promises never settle.
  return (
    <>
      {content}
      <FeedbackHost />
    </>
  );
}