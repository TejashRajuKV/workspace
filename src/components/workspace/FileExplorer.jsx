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
} from "lucide-react";
import { useCode } from "@/state/code";
import { useBoard } from "@/state/board";
import { toast, confirmDialog, promptDialog } from "./Feedback";

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
      ensureFolder(doc.path);
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
  const [busy, setBusy] = useState(false);
  const menuRef = useRef(null);

  const tree = useMemo(() => buildTree(docs), [docs, fsTick]);
  const canEdit = role !== "viewer";

  useEffect(() => {
    const close = () => setMenu(null);
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
              className="tree-row"
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
              {open ? <FolderOpen size={13} className="text-emerald-400" /> : <Folder size={13} className="text-emerald-400" />}
              <span className="truncate">{node.name}</span>
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
        <FileIcon size={13} className="text-[#8b94a7] flex-none" />
        <span className="truncate">{node.name}</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-[#0d1119] border-r border-[#232b3b]">
      <div className="flex items-center justify-between px-2.5 py-2 border-b border-[#232b3b] flex-none">
        <span className="text-[11px] font-semibold tracking-wider text-[#8b94a7] uppercase">Files</span>
        {canEdit && (
          <div className="flex gap-1">
            <button
              title="New file"
              className="p-1 rounded hover:bg-[#1b2230] text-[#8b94a7] hover:text-white"
              onClick={() => createFile("", false)}
            >
              <FilePlus2 size={13} />
            </button>
            <button
              title="New folder"
              className="p-1 rounded hover:bg-[#1b2230] text-[#8b94a7] hover:text-white"
              onClick={() => createFile("", true)}
            >
              <FolderPlus size={13} />
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-1 px-1">
        {tree.children.length === 0 ? (
          <div className="text-xs text-[#8b94a7] px-2 py-3 leading-relaxed">
            No files yet.
            {canEdit && " Use the + buttons to create your first file."}
          </div>
        ) : (
          tree.children.map((c) => renderNode(c, 0))
        )}
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-36 rounded-md border border-[#232b3b] bg-[#161b26] shadow-xl py-1 text-xs"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.doc.isFolder && (
            <>
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-[#1b2230] flex items-center gap-2"
                onClick={() => {
                  createFile(menu.doc.path, false);
                  setMenu(null);
                }}
              >
                <FilePlus2 size={12} /> New file here
              </button>
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-[#1b2230] flex items-center gap-2"
                onClick={() => {
                  createFile(menu.doc.path, true);
                  setMenu(null);
                }}
              >
                <FolderPlus size={12} /> New folder here
              </button>
            </>
          )}
          {menu.doc.id && (
            <>
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-[#1b2230] flex items-center gap-2"
                onClick={() => {
                  rename(menu.doc);
                  setMenu(null);
                }}
              >
                <Pencil size={12} /> Rename / move
              </button>
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-[#1b2230] flex items-center gap-2 text-red-400"
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

