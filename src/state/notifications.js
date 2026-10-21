"use client";

// In-app notification centre (bell) + browser Notification API.
//
// Rows live in the database (server/lib/notifications.js) and are pushed to the
// user's socket room (`user:<id>`) by the collab service. This store keeps the
// in-memory list in sync and mirrors new items to the OS notification centre
// when the user has granted permission.

import { create } from "zustand";
import { get, post, del } from "@/lib/api";
import { on } from "@/lib/socket";

export const useNotifications = create((set, get) => ({
  items: [],
  unread: 0,
  loaded: false,
  permission: typeof Notification !== "undefined" ? Notification.permission : "unsupported",

  async load() {
    try {
      const data = await get("/api/notifications");
      set({ items: data.notifications || [], unread: data.unread || 0, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  async markRead(ids) {
    if (!ids?.length) return;
    // optimistic
    const now = Date.now();
    set((s) => {
      const set0 = new Set(ids);
      const items = s.items.map((n) => (set0.has(n.id) ? { ...n, readAt: now } : n));
      return { items, unread: items.filter((n) => !n.readAt).length };
    });
    try {
      await post("/api/notifications/read", { ids });
    } catch {
      /* re-sync on next load */
    }
  },

  async markAllRead() {
    set((s) => ({ items: s.items.map((n) => (n.readAt ? n : { ...n, readAt: Date.now() })), unread: 0 }));
    try {
      await post("/api/notifications/read", { all: true });
    } catch {}
  },

  async remove(id) {
    set((s) => {
      const items = s.items.filter((n) => n.id !== id);
      return { items, unread: items.filter((n) => !n.readAt).length };
    });
    try {
      await del(`/api/notifications/${id}`);
    } catch {}
  },

  push(n) {
    if (!n?.id) return;
    set((s) => {
      if (s.items.some((x) => x.id === n.id)) return s;
      const items = [n, ...s.items].slice(0, 200);
      return { items, unread: items.filter((x) => !x.readAt).length };
    });
    mirrorToOS(n);
  },

  async requestPermission() {
    if (typeof Notification === "undefined") return "unsupported";
    try {
      const p = await Notification.requestPermission();
      set({ permission: p });
      return p;
    } catch {
      return "denied";
    }
  },

  reset() {
    set({ items: [], unread: 0, loaded: false });
  },
}));

function mirrorToOS(n) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const note = new Notification(n.title || "Infinite Workspace", {
      body: n.body || "",
      tag: n.id,
    });
    note.onclick = () => {
      try {
        window.focus();
        window.dispatchEvent(
          new CustomEvent("iw-open-notification", {
            detail: { workspaceId: n.workspaceId, linkType: n.linkType, linkId: n.linkId },
          })
        );
      } catch {}
      note.close();
    };
  } catch {}
}

let bound = false;
export function bindNotifications() {
  if (bound) return;
  bound = true;
  on("notification:new", (n) => useNotifications.getState().push(n));
  try {
    window.addEventListener("iw-open-notification", (evt) => {
      const d = evt.detail || {};
      if (d.linkType === "object" && d.linkId) {
        useNotifications.getState().markRead([]);
        window.dispatchEvent(
          new CustomEvent("iw-open-workspace", { detail: { id: d.workspaceId, objectId: d.linkId } })
        );
      } else if (d.workspaceId) {
        window.dispatchEvent(new CustomEvent("iw-open-workspace", { detail: { id: d.workspaceId } }));
      }
    });
  } catch {}
}
