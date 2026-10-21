"use client";

import { useEffect, useState } from "react";
import {
  Archive,
  ArrowRight,
  ArchiveRestore,
  Clock,
  LogOut,
  Plus,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { InfiniteBoard } from "./InfiniteBoardLogo";
import { useSession } from "@/state/session";

export default function DashboardView({ onOpen }) {
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const [workspaces, setWorkspaces] = useState(null);
  const [archived, setArchived] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [joinId, setJoinId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const res = await fetch("/api/workspaces");
    if (res.ok) {
      const data = await res.json();
      setWorkspaces(data.workspaces || []);
    }
    const arch = await fetch("/api/workspaces?archived=1");
    if (arch.ok) {
      const data = await arch.json();
      setArchived(data.workspaces || []);
    }
    const tpl = await fetch("/api/templates");
    if (tpl.ok) {
      const data = await tpl.json();
      setTemplates(data.templates || []);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; setState runs after the await
    load();
  }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, templateId: templateId || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setName("");
        setTemplateId("");
        setCreating(false);
        onOpen(data.workspace.id);
      }
    } finally {
      setBusy(false);
    }
  };

  const setArchivedFlag = async (ws, flag) => {
    await fetch(`/api/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: flag }),
    });
    load();
  };

  const join = (e) => {
    e.preventDefault();
    if (joinId.trim()) onOpen(joinId.trim());
  };

  const remove = async (ws) => {
    if (!confirm(`Delete workspace "${ws.name}"? This cannot be undone.`)) return;
    await fetch(`/api/workspaces/${ws.id}`, { method: "DELETE" });
    load();
  };

  const logout = async () => {
    await fetch("/api/auth/session", { method: "DELETE" });
    setUser(null);
  };

  const owned = workspaces?.filter((ws) => ws.role === "owner").length || 0;
  const shared = (workspaces?.length || 0) - owned;

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#170d12] text-[#fbeeda]">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-[480px] bg-[radial-gradient(70%_100%_at_50%_-10%,rgba(231,111,81,0.22),transparent_70%)]"
      />

      <header className="relative z-20 flex h-16 items-center gap-3 border-b border-[#43272e]/80 bg-[#170d12]/80 px-5 backdrop-blur">
        <InfiniteBoard size={26} />
        <span className="text-sm font-semibold tracking-tight">Infinite Workspace</span>
        <span className="hidden rounded-full border border-[#43272e] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[#a1847a] sm:inline">
          beta
        </span>
        <div className="flex-1" />
        <div className="hidden items-center gap-2 sm:flex">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-inner"
            style={{ background: user?.color }}
          >
            {user?.username?.slice(0, 2).toUpperCase()}
          </span>
          <span className="text-xs text-[#c3a596]">
            {user?.username}
          </span>
        </div>
        <button className="btn btn-ghost px-2 py-1.5" onClick={logout} title="Sign out">
          <LogOut size={15} />
        </button>
      </header>

      <main className="relative z-10 mx-auto max-w-5xl px-5 pb-16 pt-10">
        <section className="relative overflow-hidden rounded-2xl border border-[#43272e] bg-[#201317]/85 p-6 shadow-[0_40px_120px_-60px_rgba(0,0,0,0.95)] sm:p-9">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-20 -top-28 h-72 w-72 rounded-full bg-[#e76f51]/25 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-24 -left-16 h-56 w-56 rounded-full bg-[#f6c177]/10 blur-3xl"
          />
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.22em] text-[#f6c177]">
            <Sparkles size={12} /> Your studio
          </p>
          <h1 className="font-display mt-2 text-3xl leading-tight sm:text-4xl">
            Welcome back, {user?.username}
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-[#c3a596]">
            Open a workspace to sketch on an infinite canvas, write and run code together, and keep every
            change in sync in real time.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <button className="btn btn-primary px-4 py-2" onClick={() => setCreating(true)}>
              <Plus size={15} /> New workspace
            </button>
            <form onSubmit={join} className="flex items-center gap-2">
              <input
                className="field w-56 py-2 text-xs"
                placeholder="Paste a workspace ID"
                value={joinId}
                onChange={(e) => setJoinId(e.target.value)}
              />
              <button type="submit" className="btn btn-outline px-3 py-2 text-xs">
                Join
              </button>
            </form>
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[#43272e]/70 pt-4 text-[11px] text-[#a1847a]">
            <span className="flex items-center gap-1.5">
              <Users size={12} className="text-[#f4a261]" /> {workspaces ? `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}` : "—"}
            </span>
            <span>{owned} owned</span>
            <span>{shared} shared with you</span>
            {archived.length > 0 && (
              <button
                className="ml-auto inline-flex items-center gap-1 text-[#a1847a] hover:text-[#fbeeda]"
                onClick={() => setShowArchived((v) => !v)}
              >
                <Archive size={11} /> {showArchived ? "Hide" : "Show"} archived ({archived.length})
              </button>
            )}
          </div>
        </section>

        {creating && (
          <form
            onSubmit={create}
            className="mt-4 flex flex-wrap gap-2 rounded-xl border border-[#f4a261]/30 bg-[#251519] p-4"
          >
            <input
              autoFocus
              className="field min-w-48 flex-1"
              placeholder="Workspace name — e.g. Sprint 12 planning"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
            {templates.length > 0 && (
              <select
                className="field min-w-44"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                title="Start from a template"
              >
                <option value="">Blank workspace</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.fileCount} files)
                  </option>
                ))}
              </select>
            )}
            <button type="submit" className="btn btn-primary px-4" disabled={busy || !name.trim()}>
              Create
            </button>
            <button type="button" className="btn btn-ghost px-3" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </form>
        )}

        <div className="mt-9 mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">All workspaces</h2>
            <p className="mt-0.5 text-[11px] text-[#a1847a]">
              Share a workspace ID to invite teammates.
            </p>
          </div>
          <button className="btn btn-ghost px-2.5 py-1.5 text-xs" onClick={load}>
            Refresh
          </button>
        </div>

        {!workspaces && <div className="text-sm text-[#c3a596]">Loading…</div>}

        {workspaces && workspaces.length === 0 && (
          <div className="relative overflow-hidden rounded-xl border border-dashed border-[#43272e] px-8 py-14 text-center">
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-6 h-24 w-24 -translate-x-1/2 rounded-full bg-[#f4a261]/15 blur-2xl"
            />
            <p className="text-sm font-medium text-[#f3ddc9]">No workspaces yet</p>
            <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-[#a1847a]">
              Create your first workspace above — it takes a second and you can invite people right after.
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {workspaces?.map((ws) => (
            <button
              key={ws.id}
              className="group relative overflow-hidden rounded-xl border border-[#43272e] bg-[#201317] p-4 text-left transition-colors hover:border-[#f4a261]/50 hover:bg-[#251519]"
              onClick={() => onOpen(ws.id)}
            >
              <span
                aria-hidden
                className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#f4a261]/70 to-transparent opacity-0 transition-opacity group-hover:opacity-100"
              />
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-[#fbeeda]">{ws.name}</h3>
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-[#a1847a]">
                    <Clock size={11} /> {new Date(ws.updatedAt).toLocaleString()}
                  </p>
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-[#a1847a]">
                    <Users size={11} /> {ws.memberCount || 1} member{ws.memberCount === 1 ? "" : "s"}
                    {!ws.allowIdJoin && (
                      <span className="ml-1 rounded border border-[#43272e] px-1 py-px text-[9px] uppercase tracking-wide text-[#f6c177]">
                        invite-only
                      </span>
                    )}
                  </p>
                </div>
                <span
                  className={`flex-none rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                    ws.role === "owner"
                      ? "bg-amber-500/15 text-amber-400"
                      : ws.role === "editor"
                        ? "bg-orange-500/15 text-orange-300"
                        : "bg-stone-500/15 text-stone-400"
                  }`}
                >
                  {ws.role}
                </span>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2">
                <code className="truncate text-[10px] text-[#a1847a]">{ws.id}</code>
                <div className="flex flex-none items-center gap-1">
                  {ws.role !== "viewer" && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="rounded p-1 text-[#a1847a] hover:bg-amber-500/10 hover:text-amber-400"
                      title="Archive workspace"
                      onClick={(e) => {
                        e.stopPropagation();
                        setArchivedFlag(ws, true);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          setArchivedFlag(ws, true);
                        }
                      }}
                    >
                      <Archive size={13} />
                    </span>
                  )}
                  {ws.role === "owner" && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="rounded p-1 text-[#a1847a] hover:bg-red-500/10 hover:text-red-400"
                      title="Delete workspace"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(ws);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          remove(ws);
                        }
                      }}
                    >
                      <Trash2 size={13} />
                    </span>
                  )}
                  <ArrowRight
                    size={13}
                    className="text-[#a1847a] transition-transform group-hover:translate-x-0.5 group-hover:text-[#f4a261]"
                  />
                </div>
              </div>
            </button>
          ))}
        </div>

        {showArchived && archived.length > 0 && (
          <>
            <div className="mt-9 mb-3">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
                <Archive size={14} /> Archived
              </h2>
              <p className="mt-0.5 text-[11px] text-[#a1847a]">
                Hidden from the list above. Restore to keep working on them.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {archived.map((ws) => (
                <div
                  key={ws.id}
                  className="flex items-center gap-3 rounded-xl border border-[#43272e] bg-[#201317]/60 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-medium text-[#c3a596]">{ws.name}</h3>
                    <p className="mt-0.5 text-[11px] text-[#a1847a]">
                      archived {new Date(ws.updatedAt).toLocaleDateString()} · {ws.role}
                    </p>
                  </div>
                  <button
                    className="btn btn-ghost px-2.5 py-1.5 text-xs"
                    onClick={() => setArchivedFlag(ws, false)}
                  >
                    <ArchiveRestore size={13} /> Restore
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
