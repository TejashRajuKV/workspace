"use client";

import { create } from "zustand";
import { getSocket } from "@/lib/socket";

let lastSocketUser = null; // user id the current socket handshake carries

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
    try {
      const s = getSocket();
      if (user) {
        // the socket authenticated with the session cookie AT HANDSHAKE TIME.
        // After an account switch (sign-out → sign-in as someone else) a still
        // -connected socket would keep acting (presence, permissions, op
        // attribution) as the PREVIOUS user — force a fresh handshake.
        if (s.connected && lastSocketUser && lastSocketUser !== user.id) {
          s.disconnect();
        }
        lastSocketUser = user.id;
        if (s.disconnected) s.connect();
      } else {
        // signed out — drop the socket's stale identity entirely
        if (s.connected) s.disconnect();
        lastSocketUser = null;
      }
    } catch {}
  },
  openWorkspace: (workspaceId, bootstrap) =>
    set({
      view: "workspace",
      workspaceId,
      bootstrap,
      role: bootstrap.role,
    }),
  closeWorkspace: () => {
    set({ view: "dashboard", workspaceId: null, bootstrap: null, role: "viewer" });
    // keep the URL in sync with the open workspace (deep-link support)
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("w")) {
        url.searchParams.delete("w");
        window.history.replaceState(null, "", url);
      }
    } catch {}
  },
}));
