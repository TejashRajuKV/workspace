"use client";

// Notification centre: drop-down from the top-bar bell. Items come from the
// server (persistent) and arrive live over the user's socket room.

import { useEffect, useRef } from "react";
import {
  AtSign,
  Bell,
  BellRing,
  CheckCheck,
  Github,
  MessageSquare,
  UserPlus,
  X,
  Inbox,
} from "lucide-react";
import { useNotifications } from "@/state/notifications";

const ICONS = {
  mention: AtSign,
  reply: MessageSquare,
  invite: UserPlus,
  membership: UserPlus,
  github: Github,
  system: Inbox,
};

export default function NotificationsPanel({ open, onClose }) {
  const items = useNotifications((s) => s.items);
  const unread = useNotifications((s) => s.unread);
  const permission = useNotifications((s) => s.permission);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);

  if (!open) return null;

  const fmt = (ts) => {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  };

  const openItem = (n) => {
    useNotifications.getState().markRead([n.id]);
    if (n.linkType === "object" && n.linkId) {
      window.dispatchEvent(
        new CustomEvent("iw-open-workspace", { detail: { id: n.workspaceId, objectId: n.linkId } })
      );
    } else if (n.workspaceId) {
      window.dispatchEvent(new CustomEvent("iw-open-workspace", { detail: { id: n.workspaceId } }));
    }
    onClose();
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-50 w-80 max-h-[26rem] rounded-md border border-[#43272e] bg-[#201317] shadow-2xl flex flex-col"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#43272e]">
        <span className="text-xs font-semibold text-[#fbeeda] flex items-center gap-1.5">
          <Bell size={13} /> Notifications {unread ? `(${unread})` : ""}
        </span>
        <div className="flex items-center gap-1">
          <button
            title="Mark all read"
            disabled={!unread}
            onClick={() => useNotifications.getState().markAllRead()}
            className="p-1 rounded hover:bg-[#332026] text-[#c3a596] disabled:opacity-30"
          >
            <CheckCheck size={14} />
          </button>
          <button className="p-1 rounded hover:bg-[#332026] text-[#c3a596]" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      {permission === "default" && (
        <button
          onClick={() => useNotifications.getState().requestPermission()}
          className="flex items-center gap-2 px-3 py-2 text-[11px] text-amber-400 hover:bg-[#2a181d] border-b border-[#43272e] text-left"
        >
          <BellRing size={13} /> Enable desktop alerts for mentions &amp; replies
        </button>
      )}

      <div className="flex-1 overflow-y-auto">
        {!items.length && (
          <div className="text-xs text-[#c3a596] px-3 py-6 text-center leading-relaxed">
            You're all caught up.
          </div>
        )}
        {items.map((n) => {
          const Icon = ICONS[n.type] || Bell;
          return (
            <div
              key={n.id}
              className={`group flex items-start gap-2 px-3 py-2 border-b border-[#2a181d] cursor-pointer hover:bg-[#2a181d] ${
                n.readAt ? "" : "bg-[#241419]"
              }`}
              onClick={() => openItem(n)}
            >
              <span className="mt-0.5 text-amber-400 flex-none">
                <Icon size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className={`text-xs ${n.readAt ? "text-[#c3a596]" : "text-[#fbeeda] font-medium"}`}>
                  {n.title}
                </div>
                {n.body && (
                  <div className="text-[11px] text-[#a1847a] truncate mt-0.5">{n.body}</div>
                )}
                <div className="text-[10px] text-[#7a625a] mt-0.5">{fmt(n.createdAt)}</div>
              </div>
              {!n.readAt && <span className="w-2 h-2 rounded-full bg-amber-500 mt-1.5 flex-none" />}
              <button
                title="Dismiss"
                onClick={(e) => {
                  e.stopPropagation();
                  useNotifications.getState().remove(n.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[#332026] text-[#c3a596] flex-none"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
