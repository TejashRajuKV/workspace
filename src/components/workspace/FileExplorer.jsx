"use client";

// Virtual file tree for the code workspace. CRUD goes through the REST API;
// the collab service broadcasts fs:changed so every client refreshes.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  File as FileIcon,
  Folder,
  FolderOpen,
  FilePlus2,
  FolderPlus,
  Trash2,
  Pencil,
  Plus,
  Upload,
  Download,
  Copy,
  FileArchive,
  History,
  Play,
  FileUp,
} from "lucide-react";
import { useCode } from "@/state/code";
import { useBoard } from "@/state/board";
import { emitAck } from "@/lib/socket";
import { toast, confirmDialog, promptDialog } from "./Feedback";
import ImportDialog from "./ImportDialog";

function buildTree(docs) {
  const root = { name: "", path: "", children: [], isFolder: true, doc: null };
  const folders = new Map([["", root]]);
  const ensureFolder = (path) => {
    if (folders.has(path)) return folders.get(path);
    const parts = path.split("/").filter(Boolean);
    let acc = "";
    let node = root;
    for (const part of parts) {
      acc = acc ? `${acc}/${part}/` : `${part}/`;
      if (!folders.has(acc)) {
        const n = { name: part, path: acc, children: [], isFolder: true, doc: null };
        folders.set(acc, n);
        node.children.push(n);
      }
      node = folders.get(acc);
    }
    return node;
  };
  const sorted = [...docs].sort((a, b) => a.path.localeCompare(b.path));
  for (const doc of sorted) {
    if (doc.isFolder) {
      // Preserve the persisted folder document on the tree node. Without this,
      // folders synthesized from paths have no id, so rename/delete actions
      // disappear from their context menu.
      const folder = ensureFolder(doc.path);
      folder.doc = doc;
    } else {
      const parts = doc.path.split("/");
      const name = parts.pop();
      const parentPath = parts.length ? parts.join("/") + "/" : "";
      const parent = ensureFolder(parentPath);
      parent.children.push({ name, path: doc.path, isFolder: false, doc });
    }
  }
  const sortRec = (node) => {
    node.children.sort((a, b) =>
      a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1
    );
    node.children.forEach((c) => c.isFolder && sortRec(c));
  };
  sortRec(root);
  return root;
}

export default function FileExplorer({ workspaceId, onOpenFile }) {
  const docs = useCode((s) => s.docs);
  const openDoc = useCode((s) => s.openDoc);
  const activeDocId = useCode((s) => s.activeDocId);
  const fsTick = useCode((s) => s.fsTick);
  const role = useBoard((s) => s.role);
  const me = useBoard((s) => s.me);
  const [expanded, setExpanded] = useState(new Set(["/"]));
  const [menu, setMenu] = useState(null); // { doc, x, y }
  const [addMenu, setAddMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const menuRef = useRef(null);
  const uploadRef = useRef(null);
  const folderRef = useRef(null);

  const tree = useMemo(() => buildTree(docs), [docs, fsTick]);
  const canEdit = role !== "viewer";

  useEffect(() => {
    const close = () => {
      setMenu(null);
      setAddMenu(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const api = async (method, path, body) => {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(String(data.error || `HTTP ${res.status}`), "error");
        return null;
      }
      return data;
    } finally {
      setBusy(false);
    }
  };

  const refreshDocs = async () => {
    const wsId = workspaceId;
    const res = await fetch(`/api/workspaces/${wsId}/bootstrap`);
    if (res.ok) {
      const data = await res.json();
      useCode.getState().setDocs(data.docs || []);
    }
  };

  // Pick a non-colliding path: "main.js" -> "main (2).js" etc.
  const uniquePath = (name, taken) => {
    const set = taken || new Set(docs.map((d) => d.path));
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let path = name;
    let n = 2;
    while (set.has(path)) path = `${base} (${n++})${ext}`;
    return path;
  };

  // Same, but keeps the directory prefix of a full path.
  const uniqueFullPath = (path, taken) => {
    if (!taken.has(path)) return path;
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    return dir + uniquePath(path.slice(dir.length), taken);
  };

  const cleanSegment = (s) =>
    String(s)
      .replace(/[\\:*?"<>|]/g, "-")
      .replace(/^\.+$/, "_")
      .trim();

  // Current server content (the `docs` snapshot lags behind OT edits).
  const freshContent = async (docId) => {
    const res = await fetch(`/api/workspaces/${workspaceId}/bootstrap`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.docs || []).find((d) => d.id === docId)?.content ?? null;
  };

  const uploadFiles = async (fileList, { keepPaths = false } = {}) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const taken = new Set(docs.map((d) => d.path));
    let added = 0;
    for (const f of files) {
      if (f.size > 512 * 1024) {
        toast(`${f.name}: too large (max 512KB)`, "error");
        continue;
      }
      let text;
      try {
        text = await f.text();
      } catch {
        toast(`${f.name}: could not be read`, "error");
        continue;
      }
      if (text.includes("\u0000")) {
        toast(`${f.name}: binary files are not supported`, "error");
        continue;
      }
      let desired;
      if (keepPaths && f.webkitRelativePath) {
        const parts = String(f.webkitRelativePath).split(/[\\/]/).map(cleanSegment).filter(Boolean);
        if (!parts.length) continue;
        desired = parts.join("/");
      } else {
        const name = cleanSegment(f.name.replace(/[\\/]/g, "-"));
        if (!name) continue;
        desired = name;
      }
      const path = uniqueFullPath(desired, taken);
      const ok = await api("POST", `/api/workspaces/${workspaceId}/files`, {
        path,
        isFolder: false,
        content: text,
      });
      if (ok) {
        taken.add(path);
        added++;
      }
    }
    if (added) {
      await refreshDocs();
      toast(`Uploaded ${added} file${added === 1 ? "" : "s"}`, "success");
    }
  };

  const duplicate = async (doc) => {
    const content = await freshContent(doc.id);
    if (content === null) {
      toast("Could not read the file", "error");
      return;
    }
    const name = doc.path.split("/").pop();
    const dir = doc.path.slice(0, doc.path.length - name.length);
    const ok = await api("POST", `/api/workspaces/${workspaceId}/files`, {
      path: uniquePath(dir + name),
      isFolder: false,
      content,
    });
    if (ok) {
      await refreshDocs();
      if (ok.doc?.id) openDoc(ok.doc.id);
    }
  };

  const download = async (doc) => {
    const content = await freshContent(doc.id);
    if (content === null) {
      toast("Could not read the file", "error");
      return;
    }
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.path.split("/").pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const downloadZip = async (folderPath = "") => {
    if (busy) return;
    setBusy(true);
    try {
      const query = folderPath ? `?path=${encodeURIComponent(folderPath)}` : "";
      const res = await fetch(`/api/workspaces/${workspaceId}/export.zip${query}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(String(data.error || `HTTP ${res.status}`), "error");
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const match =
        /filename\*=UTF-8''([^;]+)/i.exec(disposition) ||
        /filename="([^"]+)"/i.exec(disposition);
      let name = "workspace.zip";
      if (match) {
        try {
          name = decodeURIComponent(match[1]);
        } catch {
          name = match[1];
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Downloaded ${name}`, "success");
    } catch {
      toast("Could not create the ZIP archive", "error");
    } finally {
      setBusy(false);
    }
  };

  const runFile = async (doc) => {
    try {
      await emitAck("exec:start", { fileId: doc.id, language: null }, 6000);
    } catch {
      toast("Could not start the run — is the collaboration service up?", "error");
    }
  };

  const openHistory = (doc) => {
    window.dispatchEvent(new CustomEvent("iw-open-history", { detail: { docId: doc.id } }));
  };

  const createFile = async (parentPath, isFolder) => {
    const name = await promptDialog({
      title: isFolder ? "New folder" : "New file",
      message: parentPath ? `Inside ${parentPath}` : undefined,
      placeholder: isFolder ? "src" : "main.js",
      confirmLabel: "Create",
    });
    if (!name) return;
    const path = (parentPath || "") + name + (isFolder ? "/" : "");
    const ok = await api("POST", `/api/workspaces/${workspaceId}/files`, {
      path,
      isFolder,
      content: "",
    });
    if (ok) {
      await refreshDocs();
      // open what you just made so you can type straight away
      if (!isFolder && ok.doc?.id) openDoc(ok.doc.id);
    }
  };

  const rename = async (doc) => {
    const newName = await promptDialog({
      title: "Rename / move",
      message: "Edit the full path to move it into another folder.",
      defaultValue: doc.path,
      confirmLabel: "Rename",
    });
    if (!newName || newName === doc.path) return;
    const ok = await api("PATCH", `/api/workspaces/${workspaceId}/files/${doc.id}`, {
      path: newName,
    });
    if (ok) refreshDocs();
  };

  const remove = async (doc) => {
    const confirmed = await confirmDialog({
      title: `Delete ${doc.isFolder ? "folder" : "file"}?`,
      message: doc.path,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    const ok = await api("DELETE", `/api/workspaces/${workspaceId}/files/${doc.id}`);
    if (ok) refreshDocs();
  };

  const renderNode = (node, depth) => {
    if (node.isFolder) {
      const open = expanded.has(node.path);
      return (
        <div key={node.path || "root"}>
          {node.path && (
            <div
              className="tree-row group"
              style={{ paddingLeft: 6 + depth * 12 }}
              onClick={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  next.has(node.path) ? next.delete(node.path) : next.add(node.path);
                  return next;
                })
              }
              onContextMenu={(e) => {
                if (!canEdit) return;
                e.preventDefault();
                setMenu({ doc: { path: node.path, isFolder: true, id: node.doc?.id }, x: e.clientX, y: e.clientY });
              }}
            >
              {open ? <FolderOpen size={13} className="text-amber-400" /> : <Folder size={13} className="text-amber-400" />}
              <span className="truncate">{node.name}</span>
              {canEdit && (
                <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    title="New file in this folder"
                    className="p-0.5 rounded hover:bg-[#43272e] text-[#c3a596] hover:text-amber-400"
                    onClick={(e) => {
                      e.stopPropagation();
                      createFile(node.path, false);
                    }}
                  >
                    <FilePlus2 size={11} />
                  </button>
                  <button
                    title="New folder in this folder"
                    className="p-0.5 rounded hover:bg-[#43272e] text-[#c3a596] hover:text-amber-400"
                    onClick={(e) => {
                      e.stopPropagation();
                      createFile(node.path, true);
                    }}
                  >
                    <FolderPlus size={11} />
                  </button>
                </span>
              )}
            </div>
          )}
          {open && node.children.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    return (
      <div
        key={node.path}
        className={`tree-row ${node.doc.id === activeDocId ? "active" : ""}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => {
          openDoc(node.doc.id);
          onOpenFile?.(node.doc);
        }}
        onContextMenu={(e) => {
          if (!canEdit) return;
          e.preventDefault();
          setMenu({ doc: node.doc, x: e.clientX, y: e.clientY });
        }}
      >
        <FileIcon size={13} className="text-[#c3a596] flex-none" />
        <span className="truncate">{node.name}</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-[#1c1015] border-r border-[#43272e]">
      <div className="flex items-center justify-between px-2.5 py-2 border-b border-[#43272e] flex-none">
        <span className="text-[11px] font-semibold tracking-wider text-[#c3a596] uppercase">Files</span>
        <div className="flex items-center gap-1">
          {canEdit && (
            <button
              title="Import a ZIP archive"
              aria-label="Import a ZIP archive"
              className="p-1 rounded border border-[#43272e] text-[#c3a596] hover:text-amber-400 hover:border-amber-500/40 disabled:opacity-40"
              onClick={() => setImportOpen(true)}
              disabled={busy}
            >
              <FileUp size={13} />
            </button>
          )}
          <button
            title="Download workspace as ZIP"
            aria-label="Download workspace as ZIP"
            className="p-1 rounded border border-[#43272e] text-[#c3a596] hover:text-amber-400 hover:border-amber-500/40 disabled:opacity-40"
            onClick={downloadZip}
            disabled={busy}
          >
            <FileArchive size={13} />
          </button>
          {canEdit && (
          <div className="relative">
            <button
              title="Add file or folder"
              className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-400 hover:bg-amber-500/20 disabled:opacity-50"
              onClick={(e) => {
                e.stopPropagation();
                setAddMenu((v) => !v);
              }}
              disabled={busy}
            >
              <Plus size={14} />
              <span className="text-[11px] font-medium">New</span>
            </button>
            {addMenu && (
              <div
                className="absolute right-0 top-full mt-1 z-50 w-44 rounded-md border border-[#43272e] bg-[#2a181d] shadow-xl py-1 text-xs"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                  onClick={() => {
                    setAddMenu(false);
                    createFile("", false);
                  }}
                >
                  <FilePlus2 size={12} /> New file
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                  onClick={() => {
                    setAddMenu(false);
                    createFile("", true);
                  }}
                >
                  <FolderPlus size={12} /> New folder
                </button>
                <div className="my-1 h-px bg-[#43272e]" />
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                  onClick={() => {
                    setAddMenu(false);
                    uploadRef.current?.click();
                  }}
                >
                  <Upload size={12} /> Upload files…
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                  onClick={() => {
                    setAddMenu(false);
                    folderRef.current?.click();
                  }}
                >
                  <FolderPlus size={12} /> Upload folder…
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                  onClick={() => {
                    setAddMenu(false);
                    setImportOpen(true);
                  }}
                >
                  <FileUp size={12} /> Import ZIP…
                </button>
              </div>
            )}
          </div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1 px-1">
        {tree.children.length === 0 ? (
          <div className="text-xs text-[#c3a596] px-2 py-3 leading-relaxed">
            No files yet.
            {canEdit && " Click the New + button to create your first file or folder."}
          </div>
        ) : (
          tree.children.map((c) => renderNode(c, 0))
        )}
      </div>

      <input
        ref={uploadRef}
        type="file"
        multiple
        className="hidden"
        onChange={async (e) => {
          const files = e.target.files;
          e.target.value = "";
          await uploadFiles(files);
        }}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        className="hidden"
        webkitdirectory=""
        directory=""
        onChange={async (e) => {
          const files = e.target.files;
          e.target.value = "";
          await uploadFiles(files, { keepPaths: true });
        }}
      />

      <ImportDialog workspaceId={workspaceId} open={importOpen} onClose={() => setImportOpen(false)} />

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-36 rounded-md border border-[#43272e] bg-[#2a181d] shadow-xl py-1 text-xs"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.doc.isFolder && (
            <>
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                onClick={() => {
                  createFile(menu.doc.path, false);
                  setMenu(null);
                }}
              >
                <FilePlus2 size={12} /> New file here
              </button>
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                onClick={() => {
                  createFile(menu.doc.path, true);
                  setMenu(null);
                }}
              >
                <FolderPlus size={12} /> New folder here
              </button>
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                onClick={() => {
                  downloadZip(menu.doc.path);
                  setMenu(null);
                }}
              >
                <FileArchive size={12} /> Download folder (ZIP)
              </button>
            </>
          )}
          {menu.doc.id && (
            <>
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                onClick={() => {
                  rename(menu.doc);
                  setMenu(null);
                }}
              >
                <Pencil size={12} /> Rename / move
              </button>
              {!menu.doc.isFolder && (
                <>
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                    onClick={() => {
                      duplicate(menu.doc);
                      setMenu(null);
                    }}
                  >
                    <Copy size={12} /> Duplicate
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                    onClick={() => {
                      download(menu.doc);
                      setMenu(null);
                    }}
                  >
                    <Download size={12} /> Download
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                    onClick={() => {
                      runFile(menu.doc);
                      setMenu(null);
                    }}
                  >
                    <Play size={12} /> Run
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2"
                    onClick={() => {
                      openHistory(menu.doc);
                      setMenu(null);
                    }}
                  >
                    <History size={12} /> History
                  </button>
                </>
              )}
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-[#332026] flex items-center gap-2 text-red-400"
                onClick={() => {
                  remove(menu.doc);
                  setMenu(null);
                }}
              >
                <Trash2 size={12} /> Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

