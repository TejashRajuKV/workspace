"use client";

import { useEffect, useMemo, useState } from "react";
import { DiffEditor, loader } from "@monaco-editor/react";
import {
  ArrowDownToLine,
  CheckCircle2,
  CloudUpload,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitPullRequest,
  Github,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Unplug,
  X,
} from "lucide-react";
import { toast, confirmDialog } from "./Feedback";
import { useCode } from "@/state/code";
import { defineIwTheme } from "@/lib/monacoTheme";

loader.config({ paths: { vs: "/monaco/vs" } });

const EMPTY_FORM = {
  owner: "",
  repo: "",
  branch: "main",
  token: "",
  createRepo: false,
  private: true,
};

async function readError(res) {
  const data = await res.json().catch(() => ({}));
  return String(data.error || `HTTP ${res.status}`);
}

export default function GithubDialog({ workspaceId, open, onClose }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState("Update from Infinite Workspace");
  const [prune, setPrune] = useState(false);
  const [branches, setBranches] = useState([]);
  const [pullBranch, setPullBranch] = useState("");
  const [preview, setPreview] = useState(null);
  const [pullMode, setPullMode] = useState("merge");
  const [pulling, setPulling] = useState(false);
  const [pushBranch, setPushBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [lastPush, setLastPush] = useState(null);
  const [diffs, setDiffs] = useState(null);
  const [diffFile, setDiffFile] = useState("");
  const [loadingDiffs, setLoadingDiffs] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBase, setPrBase] = useState("");
  const [prBusy, setPrBusy] = useState(false);

  const headBranch = (newBranch.trim() || pushBranch || status?.branch || "main").trim();
  const activeDiff = useMemo(
    () => (diffs || []).find((f) => f.path === diffFile) || null,
    [diffs, diffFile]
  );

  const refreshDocs = async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/bootstrap`);
    if (res.ok) {
      const data = await res.json();
      useCode.getState().setDocs(data.docs || []);
    }
  };

  const loadBranches = async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/github/branches`);
      if (!res.ok) return;
      const data = await res.json();
      setBranches(data.branches || []);
      setPullBranch((b) => b || data.current || "");
    } catch {}
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/github`);
        if (!res.ok) throw new Error(await readError(res));
        const data = await res.json();
        if (cancelled) return;
        setStatus(data);
        setShowForm(!data.connected);
        if (data.connected) {
          setPullBranch(data.branch);
          setPushBranch(data.branch);
          loadBranches();
        }
      } catch (err) {
        if (!cancelled) toast(err.message, "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
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

  const connect = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!form.owner.trim() || !form.repo.trim() || !form.branch.trim() || !form.token.trim()) {
      toast("Fill in owner, repository, branch and token", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/github`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: form.token,
          owner: form.owner,
          repo: form.repo,
          branch: form.branch,
          createRepo: form.createRepo,
          private: form.private,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setStatus(data);
      setShowForm(false);
      setForm(EMPTY_FORM);
      toast(`Linked to ${data.owner}/${data.repo}`, "success");
    } catch (err) {
      toast(err.message, "error", 7000);
    } finally {
      setBusy(false);
    }
  };

  const push = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/github/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, prune, branch: headBranch }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setStatus((s) => ({
        ...s,
        branch: data.branch || s?.branch,
        lastCommitSha: data.commitSha || s?.lastCommitSha || "",
        lastPushedAt: Date.now(),
      }));
      setPushBranch(data.branch || headBranch);
      setNewBranch("");
      setLastPush({ branch: data.branch || headBranch, commitSha: data.commitSha || "" });
      setPrTitle((t) => t || message);
      if (data.unchanged) toast("Everything is already up to date", "info");
      else
        toast(
          `Pushed ${data.uploaded} change${data.uploaded === 1 ? "" : "s"}${
            data.removed ? `, removed ${data.removed}` : ""
          } to ${data.branch || headBranch}`,
          "success",
          6000
        );
    } catch (err) {
      toast(err.message, "error", 8000);
    } finally {
      setBusy(false);
    }
  };

  const loadDiffs = async () => {
    if (loadingDiffs) return;
    setLoadingDiffs(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/github/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch: pullBranch, includeContent: true }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      const list = data.fileDiffs || [];
      setDiffs(list);
      setDiffFile(list[0]?.path || "");
      if (!list.length) toast("No file differences against this branch", "info");
    } catch (err) {
      toast(err.message, "error", 8000);
    } finally {
      setLoadingDiffs(false);
    }
  };

  const openPr = async () => {
    if (prBusy) return;
    if (!prTitle.trim()) {
      toast("Add a pull request title", "error");
      return;
    }
    setPrBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/github/pr`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: prTitle, body: message, head: headBranch, base: prBase }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      toast(
        <span className="inline-flex items-center gap-1">
          Opened PR #{data.pull.number}
          <a href={data.pull.html_url} target="_blank" rel="noreferrer" className="underline">
            view
          </a>
        </span>,
        "success",
        9000
      );
      setLastPush(null);
    } catch (err) {
      toast(err.message, "error", 8000);
    } finally {
      setPrBusy(false);
    }
  };

  const checkRemote = async () => {
    if (busy) return;
    setBusy(true);
    setPreview(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/github/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch: pullBranch }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setPreview(await res.json());
    } catch (err) {
      toast(err.message, "error", 8000);
    } finally {
      setBusy(false);
    }
  };

  const applyPull = async () => {
    if (busy || !preview) return;
    if (pullMode === "replace") {
      const ok = await confirmDialog({
        title: "Replace the workspace with GitHub?",
        message:
          "Files that exist here but not in the repository will be removed. This affects everyone in the workspace.",
        confirmLabel: "Replace",
        danger: true,
      });
      if (!ok) return;
    }
    setPulling(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/github/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch: pullBranch, mode: pullMode }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      await refreshDocs();
      setStatus((s) => ({ ...s, branch: data.branch, lastCommitSha: data.headSha }));
      setPreview(null);
      const s = data.summary || {};
      toast(
        `Pulled from ${data.branch}: +${s.created || 0} new, ${
          s.overwritten || 0
        } updated${data.removed ? `, ${data.removed} removed` : ""}`,
        "success",
        7000
      );
    } catch (err) {
      toast(err.message, "error", 8000);
    } finally {
      setPulling(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirmDialog({
      title: "Disconnect GitHub?",
      message: "The encrypted token and repository link will be removed. Files on GitHub stay untouched.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/github`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      setStatus({ connected: false });
      setShowForm(true);
      toast("GitHub disconnected", "success");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const shortSha = status?.lastCommitSha ? status.lastCommitSha.slice(0, 7) : "";

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/65 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="GitHub sync"
        className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-xl border border-[#43272e] bg-[#201317] shadow-2xl"
      >
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[#43272e] sticky top-0 bg-[#201317] z-10">
          <Github size={18} className="text-[#f4a261]" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[#fbeeda]">GitHub</h2>
            <p className="text-[11px] text-[#c3a596]">Push this workspace to a repository, or pull changes back.</p>
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

        <div className="p-5">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-[#c3a596]">
              <Loader2 size={14} className="animate-spin" /> Checking connection…
            </div>
          ) : status?.connected ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3.5">
                <div className="flex items-start gap-2.5">
                  <CheckCircle2 size={16} className="text-amber-400 mt-0.5 flex-none" />
                  <div className="min-w-0">
                    <a
                      href={status.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm font-medium text-[#fbeeda] hover:text-amber-400"
                    >
                      {status.owner}/{status.repo}
                      <ExternalLink size={12} />
                    </a>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#c3a596]">
                      <span className="inline-flex items-center gap-1">
                        <GitBranch size={11} /> {status.branch}
                      </span>
                      <span>
                        {status.lastPushedAt
                          ? `Last push ${new Date(status.lastPushedAt).toLocaleString()}`
                          : "Not pushed yet"}
                      </span>
                      {shortSha && (
                        <a
                          href={`${status.repoUrl}/commit/${status.lastCommitSha}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-amber-400/90 hover:text-amber-300"
                        >
                          {shortSha}
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-[#c3a596]">Commit message</span>
                <input
                  className="field"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  maxLength={200}
                  placeholder="Update from Infinite Workspace"
                />
              </label>

              <label className="flex items-start gap-2 text-[11px] leading-relaxed text-[#c3a596] cursor-pointer">
                <input
                  type="checkbox"
                  checked={prune}
                  onChange={(e) => setPrune(e.target.checked)}
                  className="mt-0.5 accent-amber-500"
                />
                <span>
                  Remove repository files that are not in this workspace. Leave unchecked to only add and
                  update files.
                </span>
              </label>

              <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3 space-y-2">
                <div className="flex items-center gap-2 text-[11px] text-[#c3a596]">
                  <GitBranch size={12} className="text-[#f4a261]" />
                  <span>Push to branch</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="field flex-1 min-w-32"
                    value={pushBranch}
                    onChange={(e) => setPushBranch(e.target.value)}
                    disabled={busy}
                  >
                    {(branches.length ? branches : [pushBranch || status.branch]).filter(Boolean).map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  <input
                    className="field flex-1 min-w-32"
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    placeholder="or type a new branch name"
                    disabled={busy}
                    spellCheck={false}
                  />
                </div>
                {newBranch.trim() && (
                  <p className="text-[10px] text-amber-400/90">
                    A new branch <span className="font-mono">{newBranch.trim()}</span> will be created from{" "}
                    <span className="font-mono">{pushBranch || status.branch}</span>.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button className="btn btn-primary px-3.5 py-1.5" onClick={push} disabled={busy}>
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <CloudUpload size={14} />}
                  {busy ? "Pushing…" : "Push to GitHub"}
                </button>
                <button
                  className="btn btn-ghost px-3 py-1.5"
                  onClick={() => setShowForm((v) => !v)}
                  disabled={busy}
                >
                  Change repository
                </button>
                <button
                  className="btn btn-ghost px-3 py-1.5 text-red-400 hover:text-red-300"
                  onClick={disconnect}
                  disabled={busy}
                >
                  <Unplug size={13} /> Disconnect
                </button>
              </div>

              {lastPush && (
                <div className="rounded-lg border border-amber-500/30 bg-[#2a181d] p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <GitPullRequest size={14} className="text-amber-400" />
                    <span className="text-xs font-semibold text-[#fbeeda]">Open a pull request</span>
                  </div>
                  <p className="text-[11px] text-[#c3a596]">
                    Push landed on <span className="font-mono text-[#fbeeda]">{lastPush.branch}</span>. Open a PR to
                    merge it into your main branch.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="field flex-1 min-w-40"
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                      placeholder="Pull request title"
                      maxLength={256}
                    />
                    <input
                      className="field w-32"
                      value={prBase}
                      onChange={(e) => setPrBase(e.target.value)}
                      placeholder="base: main"
                      spellCheck={false}
                    />
                    <button className="btn btn-primary px-3 py-1.5" onClick={openPr} disabled={prBusy}>
                      {prBusy ? <Loader2 size={14} className="animate-spin" /> : <GitPullRequest size={14} />}
                      {prBusy ? "Opening…" : "Open PR"}
                    </button>
                    <button className="btn btn-ghost px-2.5 py-1.5" onClick={() => setLastPush(null)}>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-[#43272e] space-y-3">
                <div className="flex items-center gap-2">
                  <ArrowDownToLine size={14} className="text-amber-400" />
                  <span className="text-xs font-semibold text-[#fbeeda]">Pull from GitHub</span>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    className="field flex-1"
                    value={pullBranch}
                    onChange={(e) => {
                      setPullBranch(e.target.value);
                      setPreview(null);
                    }}
                    disabled={busy || pulling}
                  >
                    {(branches.length ? branches : [pullBranch]).filter(Boolean).map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-ghost px-3 py-1.5"
                    onClick={checkRemote}
                    disabled={busy || pulling || !pullBranch}
                    title="Compare this workspace with the branch"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    Check
                  </button>
                  <button
                    className="btn btn-ghost px-3 py-1.5"
                    onClick={loadDiffs}
                    disabled={loadingDiffs || !pullBranch}
                    title="Show a line-by-line diff"
                  >
                    {loadingDiffs ? <Loader2 size={14} className="animate-spin" /> : <FileDiff size={14} />}
                    Changes
                  </button>
                </div>

                {preview && (
                  <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3 space-y-2">
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                      <span className="text-emerald-400">+{preview.counts.added} new</span>
                      <span className="text-amber-400">~{preview.counts.modified} changed</span>
                      <span className="text-red-400">−{preview.counts.deleted} local-only</span>
                      <span className="text-[#c3a596]">{preview.counts.unchanged} unchanged</span>
                    </div>
                    {preview.counts.added + preview.counts.modified + preview.counts.deleted === 0 ? (
                      <p className="text-[11px] text-[#c3a596]">This workspace already matches the branch.</p>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center gap-3 text-[11px] text-[#c3a596]">
                          <label className="inline-flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="radio"
                              name="pullmode"
                              className="accent-amber-500"
                              checked={pullMode === "merge"}
                              onChange={() => setPullMode("merge")}
                            />
                            Merge (keep my local-only files)
                          </label>
                          <label className="inline-flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="radio"
                              name="pullmode"
                              className="accent-amber-500"
                              checked={pullMode === "replace"}
                              onChange={() => setPullMode("replace")}
                            />
                            Replace (match the branch exactly)
                          </label>
                        </div>
                        {preview.truncated && (
                          <p className="text-[11px] text-amber-400">
                            Many changes — merge is unavailable, use Replace.
                          </p>
                        )}
                        <button
                          className="btn btn-primary px-3.5 py-1.5"
                          onClick={applyPull}
                          disabled={busy || pulling || (pullMode === "merge" && preview.truncated)}
                        >
                          {pulling ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}
                          {pulling ? "Pulling…" : pullMode === "replace" ? "Replace workspace" : "Pull changes"}
                        </button>
                      </>
                    )}
                  </div>
                )}
                {diffs && (
                  <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-[#c3a596]">
                        {diffs.length} file{diffs.length === 1 ? "" : "s"} differ from{" "}
                        <span className="font-mono text-[#fbeeda]">{pullBranch}</span>
                      </span>
                      <button className="text-[11px] text-[#a1847a] hover:text-white" onClick={() => setDiffs(null)}>
                        Hide
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                      {diffs.map((f) => (
                        <button
                          key={f.path}
                          onClick={() => setDiffFile(f.path)}
                          className={`rounded px-2 py-0.5 text-[10px] font-mono border ${
                            diffFile === f.path
                              ? "border-amber-500/60 bg-amber-500/10 text-amber-300"
                              : "border-[#43272e] text-[#c3a596] hover:text-white"
                          }`}
                        >
                          {f.path}
                        </button>
                      ))}
                    </div>
                    {activeDiff && (
                      <div className="h-64 rounded overflow-hidden border border-[#43272e]">
                        <DiffEditor
                          height="100%"
                          theme="iw-dark"
                          original={activeDiff.remote ?? ""}
                          modified={activeDiff.local ?? ""}
                          beforeMount={defineIwTheme}
                          options={{
                            readOnly: true,
                            renderSideBySide: false,
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            fontSize: 12,
                            wordWrap: "on",
                          }}
                        />
                      </div>
                    )}
                    <p className="text-[10px] text-[#a1847a]">
                      Red = on GitHub, green = in this workspace. Read-only preview.
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3.5 text-xs leading-relaxed text-[#c3a596]">
              Connect a repository to push files from here. You need a GitHub token with{" "}
              <span className="text-[#fbeeda]">Contents: Read and write</span> access.{" "}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noreferrer"
                className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
              >
                Create a token
              </a>
              .
            </div>
          )}

          {!loading && showForm && (
            <form onSubmit={connect} className={status?.connected ? "mt-5 pt-5 border-t border-[#43272e]" : "mt-4"}>
              <div className="grid grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-[#c3a596]">Owner</span>
                  <input
                    className="field"
                    value={form.owner}
                    onChange={(e) => setForm({ ...form, owner: e.target.value })}
                    placeholder="octocat"
                    autoComplete="off"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-[#c3a596]">Repository</span>
                  <input
                    className="field"
                    value={form.repo}
                    onChange={(e) => setForm({ ...form, repo: e.target.value })}
                    placeholder="my-project"
                    autoComplete="off"
                  />
                </label>
              </div>
              <label className="mt-2.5 block">
                <span className="mb-1 block text-[11px] font-medium text-[#c3a596]">Branch</span>
                <input
                  className="field"
                  value={form.branch}
                  onChange={(e) => setForm({ ...form, branch: e.target.value })}
                  placeholder="main"
                  autoComplete="off"
                />
              </label>
              <label className="mt-2.5 block">
                <span className="mb-1 flex items-center gap-1 text-[11px] font-medium text-[#c3a596]">
                  <KeyRound size={11} /> Personal access token
                </span>
                <input
                  className="field font-mono"
                  type="password"
                  value={form.token}
                  onChange={(e) => setForm({ ...form, token: e.target.value })}
                  placeholder="github_pat_… or ghp_…"
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <span className="mt-1 block text-[10px] leading-relaxed text-[#a1847a]">
                  Stored encrypted on the server and never shown again.
                </span>
              </label>

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-[#c3a596]">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.createRepo}
                    onChange={(e) => setForm({ ...form, createRepo: e.target.checked })}
                    className="accent-amber-500"
                  />
                  Create repository if missing
                </label>
                {form.createRepo && (
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.private}
                      onChange={(e) => setForm({ ...form, private: e.target.checked })}
                      className="accent-amber-500"
                    />
                    <Lock size={11} /> Private
                  </label>
                )}
              </div>

              <div className="mt-4 flex items-center gap-2">
                <button type="submit" className="btn btn-primary px-3.5 py-1.5" disabled={busy}>
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Github size={14} />}
                  {busy ? "Connecting…" : status?.connected ? "Update connection" : "Connect repository"}
                </button>
                {status?.connected && (
                  <button
                    type="button"
                    className="btn btn-ghost px-3 py-1.5"
                    onClick={() => setShowForm(false)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
