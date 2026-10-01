"use client";

import { create } from "zustand";
import { getSocket } from "@/lib/socket";

// Global session/view state. The whole app is a SPA on "/" (the preview
// gateway exposes a single route), so view switching happens here.
export const useSession = create((set, get) => ({
  view: "loading", // loading | auth | dashboard | workspace
  user: null,
  workspaceId: null,
  role: "viewer",
  bootstrap: null,

  setView: (view) => set({ view }),
  setUser: (user) => {
    set({ user, view: user ? (get().view === "auth" || get().view === "loading" ? "dashboard" : get().view) : "auth" });
    if (user) {
      // the realtime socket may have been rejected before login — reconnect
      try {
        const s = getSocket();
        if (s.disconnected) s.connect();
      } catch {}
    }
  },
  openWorkspace: (workspaceId, bootstrap) =>
    set({
      view: "workspace",
      workspaceId,
      bootstrap,
      role: bootstrap.role,
    }),
  closeWorkspace: () =>
    set({ view: "dashboard", workspaceId: null, bootstrap: null, role: "viewer" }),
}));
