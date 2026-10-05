"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, LogOut, Copy } from "lucide-react";
import { InfiniteBoard } from "./InfiniteBoardLogo";
import { useSession } from "@/state/session";
import { confirmDialog, toast } from "./Feedback";

export default function DashboardView({ onOpen }) {
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const [workspaces, setWorkspaces] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [joinId, setJoinId] = useState("");
  const [busy, setBusy] = useState(false);

  const [loadError, setLoadError] = useState(false);

  const load = async () => {
    try {
      const res = await fetch("/api/workspaces");
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setWorkspaces(data.workspaces || []);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  };

  useEffect(() => {
    let alive = true;
    fetch("/api/workspaces")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => alive && setWorkspaces(data.workspaces || []))
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
  }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (res.ok) {
        setName("");
        setCreating(false);
        onOpen(data.workspace.id);
      } else toast(data.error || "Could not create workspace", "error");
    } catch {
      toast("Network error — could not create workspace", "error");
    } finally {
      setBusy(false);
    }
  };

  const join = (e) => {
    e.preventDefault();
    if (joinId.trim()) onOpen(joinId.trim());
  };

  const remove = async (ws) => {
    const ok = await confirmDialog({
      title: `Delete "${ws.name}"?`,
      message: "The board, files and history are permanently removed for everyone. This cannot be undone.",
      confirmLabel: "Delete workspace",
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/workspaces/${ws.id}`, { method: "DELETE" });
    if (!res.ok) toast("Could not delete workspace", "error");
    load();
  };

  const logout = async () => {
    await fetch("/api/auth/session", { method: "DELETE" });
    setUser(null);
  };

  return (
    <div className="min-h-screen bg-[#0b0e14]">
      <header className="h-14 border-b border-[#232b3b] flex items-center px-5 gap-3">
        <InfiniteBoard size={24} />
        <span className="font-semibold text-sm text-[#e6e9ef]">Infinite Workspace</span>
        <div className="flex-1" />
        <span className="text-xs text-[#8b94a7] hidden sm:block">
          signed in as <span className="text-[#e6e9ef] font-medium">{user?.username}</span>
        </span>
        <span
          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
          style={{ background: user?.color }}
        >
          {user?.username?.slice(0, 2).toUpperCase()}
        </span>
        <button className="btn btn-ghost px-2 py-1.5" onClick={logout} title="Sign out">
          <LogOut size={15} />
        </button>
      </header>

      <main className="max-w-4xl mx-auto px-5 py-8">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-bold text-[#e6e9ef]">Your workspaces</h2>
            <p className="text-xs text-[#8b94a7] mt-0.5">
              Each workspace is a shared infinite board + code sandbox. Share the ID to collaborate.
            </p>
          </div>
          <button className="btn btn-primary px-3.5 py-2" onClick={() => setCreating(true)}>
            <Plus size={15} /> New workspace
          </button>
        </div>

        {creating && (
          <form onSubmit={create} className="mb-5 rounded-xl border border-[#232b3b] bg-[#10141d] p-4 flex gap-2 flex-wrap">
            <input
              autoFocus
              className="field flex-1 min-w-48"
              placeholder="Workspace name — e.g. Sprint 12 planning"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
            <button type="submit" className="btn btn-primary px-4" disabled={busy || !name.trim()}>
              Create
            </button>
            <button type="button" className="btn btn-ghost px-3" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </form>
        )}

        <form onSubmit={join} className="mb-6 flex gap-2 items-center flex-wrap">
          <span className="text-xs text-[#8b94a7]">Join by ID:</span>
          <input
            className="field !w-64 max-w-full py-1.5 text-xs"
            placeholder="paste a workspace id"
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
          />
          <button type="submit" className="btn btn-outline px-3 py-1.5 text-xs">
            Join
          </button>
        </form>

        {!workspaces && !loadError && <div className="text-sm text-[#8b94a7]">Loading…</div>}
        {!workspaces && loadError && (
          <div className="rounded-xl border border-red-900/60 bg-red-950/20 p-6 text-center">
            <p className="text-sm text-red-300">Couldn't load your workspaces.</p>
            <button className="btn btn-outline px-3 py-1.5 mt-3 text-xs" onClick={load}>
              Retry
            </button>
          </div>
        )}
        {workspaces && workspaces.length === 0 && (
          <div className="rounded-xl border border-dashed border-[#232b3b] p-10 text-center">
            <p className="text-sm text-[#8b94a7]">No workspaces yet.</p>
            <p className="text-xs text-[#5b6478] mt-1">Create one above — it takes a second.</p>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {workspaces?.map((ws) => (
            <div
              key={ws.id}
              role="link"
              tabIndex={0}
              className="text-left cursor-pointer rounded-xl border border-[#232b3b] bg-[#10141d] hover:border-emerald-600/50 hover:bg-[#121722] focus-visible:border-emerald-500 outline-none transition-colors p-4"
              onClick={() => onOpen(ws.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(ws.id);
                }
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm text-[#e6e9ef] truncate">{ws.name}</h3>
                  <p className="text-[11px] text-[#5b6478] mt-0.5">
                    Updated {new Date(ws.updatedAt).toLocaleString()}
                  </p>
                </div>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-medium uppercase flex-none ${
                    ws.role === "owner"
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-slate-500/15 text-slate-400"
                  }`}
                >
                  {ws.role}
                </span>
              </div>
              <div className="flex items-center justify-between mt-3 gap-2">
                <code className="text-[10px] text-[#5b6478] truncate">{ws.id}</code>
                <div className="flex items-center gap-0.5 flex-none">
                  <button
                    type="button"
                    title="Copy workspace ID"
                    aria-label="Copy workspace ID"
                    className="p-1 rounded text-[#5b6478] hover:text-emerald-400 hover:bg-emerald-500/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard
                        ?.writeText(ws.id)
                        .then(() => toast("Workspace ID copied — share it to collaborate", "success", 2500))
                        .catch(() => toast("Couldn't copy — select the ID manually", "error"));
                    }}
                  >
                    <Copy size={13} />
                  </button>
                  {ws.role === "owner" && (
                    <button
                      type="button"
                      title="Delete workspace"
                      aria-label="Delete workspace"
                      className="p-1 rounded text-[#5b6478] hover:text-red-400 hover:bg-red-500/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(ws);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
