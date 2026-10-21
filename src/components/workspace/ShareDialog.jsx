"use client";

// Share & members: invite links, roles, join policy, ownership transfer.

import { useEffect, useState } from "react";
import {
  Copy,
  Crown,
  Globe,
  Link2,
  Loader2,
  LogOut,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { toast, confirmDialog } from "./Feedback";

async function readError(res) {
  const data = await res.json().catch(() => ({}));
  return String(data.error || `HTTP ${res.status}`);
}

export default function ShareDialog({ workspaceId, open, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inviteRole, setInviteRole] = useState("editor");
  const [inviteHours, setInviteHours] = useState(168);
  const [inviteUses, setInviteUses] = useState(1);
  const [lastInvite, setLastInvite] = useState(null);
  const [shares, setShares] = useState([]);
  const [shareHours, setShareHours] = useState(0);
  const [lastShare, setLastShare] = useState(null);
  const [bulkNames, setBulkNames] = useState("");
  const [bulkRole, setBulkRole] = useState("editor");

  const role = data?.role || "viewer";
  const isOwner = role === "owner";

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`);
      if (!res.ok) throw new Error(await readError(res));
      const meta = await res.json();
      setData(meta);
      if (meta.role === "owner") {
        const inv = await fetch(`/api/workspaces/${workspaceId}/invites`);
        if (inv.ok) setInvites((await inv.json()).invites || []);
        const sh = await fetch(`/api/workspaces/${workspaceId}/share-links`);
        if (sh.ok) setShares((await sh.json()).shares || []);
      }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const call = async (method, path, body) => {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(await readError(res));
      return await res.json().catch(() => ({}));
    } catch (err) {
      toast(err.message, "error", 7000);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const setMemberRole = async (userId, next) => {
    const ok = await call("PATCH", `/api/workspaces/${workspaceId}/members/${userId}`, { role: next });
    if (ok) {
      await load();
      onChanged?.();
    }
  };

  const removeMember = async (userId, username) => {
    const ok = await confirmDialog({
      title: `Remove ${username}?`,
      message: "They lose access to this workspace immediately.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    const res = await call("DELETE", `/api/workspaces/${workspaceId}/members/${userId}`);
    if (res) {
      await load();
      onChanged?.();
    }
  };

  const leave = async (userId) => {
    const ok = await confirmDialog({
      title: "Leave this workspace?",
      message: "You will need a new invite or the workspace ID to come back.",
      confirmLabel: "Leave",
      danger: true,
    });
    if (!ok) return;
    const res = await call("DELETE", `/api/workspaces/${workspaceId}/members/${userId}`);
    if (res) {
      onChanged?.();
      onClose();
    }
  };

  const transfer = async (userId, username) => {
    const ok = await confirmDialog({
      title: `Make ${username} the owner?`,
      message: "You will become an editor. This cannot be undone by you.",
      confirmLabel: "Transfer",
      danger: true,
    });
    if (!ok) return;
    const res = await call("POST", `/api/workspaces/${workspaceId}/transfer`, { userId });
    if (res) {
      await load();
      onChanged?.();
    }
  };

  const createInvite = async () => {
    const res = await call("POST", `/api/workspaces/${workspaceId}/invites`, {
      role: inviteRole,
      expiresInHours: inviteHours,
      maxUses: inviteUses,
    });
    if (!res) return;
    setLastInvite(res);
    await load();
  };

  const revokeInvite = async (inviteId) => {
    const res = await call("DELETE", `/api/workspaces/${workspaceId}/invites/${inviteId}`);
    if (res) await load();
  };

  const createShare = async () => {
    const res = await call("POST", `/api/workspaces/${workspaceId}/share-links`, {
      expiresInHours: Number(shareHours) || 0,
    });
    if (!res) return;
    setLastShare(res.share);
    await load();
  };

  const revokeShare = async (linkId) => {
    const res = await call("DELETE", `/api/workspaces/${workspaceId}/share-links/${linkId}`);
    if (res) {
      if (lastShare?.id === linkId) setLastShare(null);
      await load();
    }
  };

  const applyBulk = async () => {
    const usernames = bulkNames
      .split(/[\s,;\n]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    if (!usernames.length) {
      toast("Enter at least one username", "error");
      return;
    }
    const res = await call("POST", `/api/workspaces/${workspaceId}/members/bulk`, {
      usernames,
      role: bulkRole,
    });
    if (!res) return;
    const parts = [];
    if (res.added?.length) parts.push(`Added ${res.added.length} as ${res.role}`);
    if (res.alreadyMember?.length) parts.push(`${res.alreadyMember.length} already in`);
    if (res.missing?.length) parts.push(`${res.missing.length} not found`);
    toast(parts.join(" · ") || "Nothing to do", res.added?.length ? "success" : "info", 7000);
    setBulkNames("");
    await load();
    onChanged?.();
  };

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`, "success");
    } catch {
      toast(text, "info", 8000);
    }
  };

  const toggleJoin = async () => {
    const res = await call("PATCH", `/api/workspaces/${workspaceId}`, {
      allowIdJoin: !data.workspace.allowIdJoin,
    });
    if (res) {
      setData((d) => ({ ...d, workspace: { ...d.workspace, allowIdJoin: !d.workspace.allowIdJoin } }));
      toast(res.workspace.allowIdJoin ? "Anyone with the ID can join" : "Invite-only", "success");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/65 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share workspace"
        className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-xl border border-[#43272e] bg-[#201317] shadow-2xl"
      >
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[#43272e] sticky top-0 bg-[#201317] z-10">
          <Users size={18} className="text-[#f4a261]" />
          <div>
            <h2 className="text-sm font-semibold text-[#fbeeda]">Share</h2>
            <p className="text-[11px] text-[#c3a596]">Members, roles and invite links.</p>
          </div>
          <button
            className="ml-auto p-1.5 rounded-md text-[#a1847a] hover:text-white hover:bg-[#332026]"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {loading && !data ? (
            <div className="flex items-center gap-2 text-xs text-[#c3a596]">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : data ? (
            <>
              <div className="flex items-center gap-2 text-[11px] text-[#c3a596]">
                <span>Workspace ID</span>
                <button
                  className="inline-flex items-center gap-1 rounded bg-[#332026] border border-[#43272e] px-1.5 py-0.5 font-mono text-[10px] hover:text-white"
                  onClick={() => copy(workspaceId, "Workspace ID")}
                >
                  <span className="max-w-40 truncate">{workspaceId}</span>
                  <Copy size={10} />
                </button>
              </div>

              {isOwner && (
                <label className="flex items-start gap-2 text-[11px] leading-relaxed text-[#c3a596] cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-amber-500"
                    checked={data.workspace.allowIdJoin}
                    onChange={toggleJoin}
                    disabled={busy}
                  />
                  <span>
                    Anyone signed in can join with the workspace ID. Turn off to make this workspace
                    invite-only.
                  </span>
                </label>
              )}

              <div>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#c3a596]">
                  Members ({data.members.length})
                </h3>
                <div className="space-y-1">
                  {data.members.map((m) => (
                    <div
                      key={m.user.id}
                      className="flex items-center gap-2 rounded-lg border border-[#43272e] bg-[#2a181d] px-2.5 py-2"
                    >
                      <span
                        className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-none"
                        style={{ background: m.user.color }}
                      >
                        {m.user.username.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 truncate text-xs text-[#fbeeda]">
                        {m.user.username}
                        {m.user.id === data.me?.id ? " (you)" : ""}
                      </span>
                      {m.role === "owner" ? (
                        <span className="ml-auto inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-amber-400">
                          <Crown size={11} /> owner
                        </span>
                      ) : (
                        <>
                          <select
                            className="ml-auto rounded border border-[#43272e] bg-[#1c1015] px-1.5 py-0.5 text-[11px] text-[#fbeeda]"
                            value={m.role}
                            onChange={(e) => setMemberRole(m.user.id, e.target.value)}
                            disabled={!isOwner || busy}
                          >
                            <option value="editor">editor</option>
                            <option value="viewer">viewer</option>
                          </select>
                          {isOwner && (
                            <>
                              <button
                                className="p-1 rounded text-[#c3a596] hover:text-amber-400"
                                title="Transfer ownership"
                                onClick={() => transfer(m.user.id, m.user.username)}
                                disabled={busy}
                              >
                                <ShieldCheck size={13} />
                              </button>
                              <button
                                className="p-1 rounded text-[#c3a596] hover:text-red-400"
                                title="Remove member"
                                onClick={() => removeMember(m.user.id, m.user.username)}
                                disabled={busy}
                              >
                                <Trash2 size={13} />
                              </button>
                            </>
                          )}
                          {!isOwner && m.user.id === data.me?.id && (
                            <button
                              className="p-1 rounded text-[#c3a596] hover:text-red-400"
                              title="Leave workspace"
                              onClick={() => leave(m.user.id)}
                              disabled={busy}
                            >
                              <LogOut size={13} />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {isOwner && (
                <div className="pt-4 border-t border-[#43272e] space-y-2">
                  <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#c3a596]">
                    <UserPlus size={12} /> Add several people
                  </h3>
                  <textarea
                    className="field w-full h-16 resize-none text-[11px] font-mono"
                    placeholder="usernames separated by spaces, commas or new lines"
                    value={bulkNames}
                    onChange={(e) => setBulkNames(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="flex items-center gap-2">
                    <select
                      className="rounded border border-[#43272e] bg-[#1c1015] px-2 py-1 text-[11px] text-[#fbeeda]"
                      value={bulkRole}
                      onChange={(e) => setBulkRole(e.target.value)}
                    >
                      <option value="editor">editor</option>
                      <option value="viewer">viewer</option>
                    </select>
                    <button className="btn btn-primary px-3 py-1.5" onClick={applyBulk} disabled={busy}>
                      <UserPlus size={13} /> Add members
                    </button>
                  </div>
                </div>
              )}

              {isOwner && (
                <div className="pt-4 border-t border-[#43272e] space-y-3">
                  <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#c3a596]">
                    <Globe size={12} /> Public read-only link
                  </h3>
                  <p className="text-[11px] leading-relaxed text-[#a1847a]">
                    Anyone with the link can view the board and files without signing in. Editing is disabled.
                  </p>
                  <div className="flex items-center gap-2">
                    <select
                      className="rounded border border-[#43272e] bg-[#1c1015] px-2 py-1 text-[11px] text-[#fbeeda]"
                      value={shareHours}
                      onChange={(e) => setShareHours(e.target.value)}
                    >
                      <option value={0}>Never expires</option>
                      <option value={24}>Expires in 24 hours</option>
                      <option value={168}>Expires in 7 days</option>
                      <option value={720}>Expires in 30 days</option>
                    </select>
                    <button className="btn btn-primary px-3 py-1.5" onClick={createShare} disabled={busy}>
                      <Globe size={13} /> Create link
                    </button>
                  </div>

                  {lastShare && (
                    <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
                      <code className="min-w-0 flex-1 truncate text-[10px] text-amber-200">
                        {location.origin}{lastShare.url}
                      </code>
                      <button
                        className="btn btn-ghost px-2 py-1"
                        onClick={() => copy(`${location.origin}${lastShare.url}`, "Public link")}
                      >
                        <Copy size={12} /> Copy
                      </button>
                    </div>
                  )}

                  {shares.length > 0 && (
                    <div className="space-y-1">
                      {shares.map((s) => (
                        <div
                          key={s.id}
                          className="flex items-center gap-2 rounded border border-[#43272e] px-2 py-1.5 text-[11px] text-[#c3a596]"
                        >
                          <span className="uppercase tracking-wide text-[10px] text-amber-400">{s.role}</span>
                          <span>
                            {s.revoked
                              ? "revoked"
                              : s.expiresAt
                                ? `expires ${new Date(s.expiresAt).toLocaleDateString()}`
                                : "never expires"}
                          </span>
                          <button
                            className="ml-auto p-1 rounded hover:text-red-400 disabled:opacity-40"
                            title={s.revoked ? "Already revoked" : "Revoke"}
                            onClick={() => revokeShare(s.id)}
                            disabled={busy || s.revoked}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {isOwner && (
                <div className="pt-4 border-t border-[#43272e] space-y-3">
                  <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#c3a596]">
                    <Link2 size={12} /> Invite link
                  </h3>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="block">
                      <span className="mb-1 block text-[10px] text-[#a1847a]">Role</span>
                      <select
                        className="rounded border border-[#43272e] bg-[#1c1015] px-2 py-1 text-[11px] text-[#fbeeda]"
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value)}
                      >
                        <option value="editor">editor</option>
                        <option value="viewer">viewer</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] text-[#a1847a]">Expires (hours)</span>
                      <input
                        type="number"
                        min="1"
                        max="720"
                        className="w-24 rounded border border-[#43272e] bg-[#1c1015] px-2 py-1 text-[11px] text-[#fbeeda]"
                        value={inviteHours}
                        onChange={(e) => setInviteHours(e.target.value)}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] text-[#a1847a]">Max uses</span>
                      <input
                        type="number"
                        min="1"
                        max="100"
                        className="w-20 rounded border border-[#43272e] bg-[#1c1015] px-2 py-1 text-[11px] text-[#fbeeda]"
                        value={inviteUses}
                        onChange={(e) => setInviteUses(e.target.value)}
                      />
                    </label>
                    <button className="btn btn-primary px-3 py-1.5" onClick={createInvite} disabled={busy}>
                      <UserPlus size={13} /> Create link
                    </button>
                  </div>

                  {lastInvite && (
                    <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
                      <code className="min-w-0 flex-1 truncate text-[10px] text-amber-200">
                        {location.origin}
                        {lastInvite.path}
                      </code>
                      <button
                        className="btn btn-ghost px-2 py-1"
                        onClick={() => copy(`${location.origin}${lastInvite.path}`, "Invite link")}
                      >
                        <Copy size={12} /> Copy
                      </button>
                    </div>
                  )}

                  {invites.length > 0 && (
                    <div className="space-y-1">
                      {invites.map((i) => (
                        <div
                          key={i.id}
                          className="flex items-center gap-2 rounded border border-[#43272e] px-2 py-1.5 text-[11px] text-[#c3a596]"
                        >
                          <span className="uppercase tracking-wide text-[10px] text-amber-400">{i.role}</span>
                          <span>
                            {i.uses}/{i.maxUses} used
                          </span>
                          <span>{i.expired ? "expired" : `expires ${new Date(i.expiresAt).toLocaleDateString()}`}</span>
                          <button
                            className="ml-auto p-1 rounded hover:text-red-400"
                            title="Revoke"
                            onClick={() => revokeInvite(i.id)}
                            disabled={busy}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
