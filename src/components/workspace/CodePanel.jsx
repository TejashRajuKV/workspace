"use client";

// Collaborative code editor panel: Monaco + tabs + remote cursors.
// Monaco is vendored locally (public/monaco) so the app is fully self-hosted.

import { useEffect, useRef, useState, useCallback } from "react";
import Editor, { loader } from "@monaco-editor/react";
import { X } from "lucide-react";
import { useCode } from "@/state/code";
import { useBoard, sendPresence } from "@/state/board";
import { on } from "@/lib/socket";
import TextOperation from "@/shared/ot";

loader.config({ paths: { vs: "/monaco/vs" } });

function languageOf(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
      return "javascript";
    case "py":
      return "python";
    case "json":
      return "json";
    case "html":
      return "html";
    case "css":
      return "css";
    case "md":
      return "markdown";
    default:
      return "plaintext";
  }
}

const remotesRef = { users: new Map() }; // userId → {name, color, fileId, offset, anchor}

export default function CodePanel({ onRunFile }) {
  const docs = useCode((s) => s.docs);
  const openTabs = useCode((s) => s.openTabs);
  const activeDocId = useCode((s) => s.activeDocId);
  const openDoc = useCode((s) => s.openDoc);
  const closeDoc = useCode((s) => s.closeDoc);
  const role = useBoard((s) => s.role);

  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const modelsRef = useRef(new Map()); // docId → monaco model
  const applyingRef = useRef(false);
  const activeDoc = docs.find((d) => d.id === activeDocId);

  const updateRemoteCursors = useCallback(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor || !activeDocId) return;
    const model = editor.getModel();
    if (!model) return;
    const state = useCode.getState().getDocState(activeDocId);
    const remotes = state?.remoteCursors || new Map();
    const newDecorations = [];
    for (const [uid, cur] of remotes) {
      const info = remotesRef.users.get(uid);
      const color = info?.color || "#8b5cf6";
      const name = info?.name || "user";
      const pos = model.getPositionAt(Math.min(cur.offset ?? 0, model.getValueLength()));
      const selStart = model.getPositionAt(Math.min(cur.anchor ?? cur.offset ?? 0, model.getValueLength()));
      if (cur.anchor != null && cur.anchor !== cur.offset) {
        newDecorations.push({
          range: new monaco.Range(
            Math.min(selStart.lineNumber, pos.lineNumber),
            Math.min(selStart.column, pos.column),
            Math.max(selStart.lineNumber, pos.lineNumber),
            Math.max(selStart.column, pos.column)
          ),
          options: { className: `remote-selection rc-bg-${hashColor(color)}`, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
        });
      }
      newDecorations.push({
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        options: {
          className: `remote-cursor rc-fg-${hashColor(color)}`,
          afterContentClassName: `rc-label rc-label-${hashColor(color)}`,
          hoverMessage: { value: `**${name}**` },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    // one decorations collection per editor, replaced wholesale
    if (!editor.__iwDecorations) editor.__iwDecorations = editor.createDecorationsCollection([]);
    editor.__iwDecorations.set(newDecorations);
  }, [activeDocId]);

  // listen for remote ops → apply to the active model
  useEffect(() => {
    const handler = (evt) => {
      const { docId, op } = evt.detail || {};
      if (!op) return;
      const model = modelsRef.current.get(docId);
      if (!model || docId !== useCode.getState().activeDocId) return;
      applyingRef.current = true;
      try {
        // applyRemote hands back a ready TextOperation (JSON only on legacy paths)
        applyTextOpToModel(monacoRef.current, model, op instanceof TextOperation ? op : TextOperation.fromJSON(op));
      } catch {}
      applyingRef.current = false;
      updateRemoteCursors();
    };
    window.addEventListener("iw-doc-remote", handler);
    return () => window.removeEventListener("iw-doc-remote", handler);
  }, [updateRemoteCursors]);

  // remote editor presence arrives via presence:state → board store is not
  // aware of editors; handle it here
  const styleElRef = useRef(null);
  useEffect(() => {
    const styleEl = document.createElement("style");
    document.head.appendChild(styleEl);
    styleElRef.current = styleEl;
    return () => styleEl.remove();
  }, []);

  useEffect(() => {
    const off = on("presence:state", ({ users }) => {
      if (!users) return;
      const me = useBoard.getState().me;
      remotesRef.users.clear();
      let css = "";
      for (const rec of Object.values(users)) {
        if (!rec?.user || (me && rec.user.id === me.id)) continue;
        if (rec.editor) {
          remotesRef.users.set(rec.user.id, {
            name: rec.user.username,
            color: rec.user.color,
            fileId: rec.editor.fileId,
            offset: rec.editor.offset,
            anchor: rec.editor.anchor,
          });
        }
        const h = hashColor(rec.user.color);
        const name = String(rec.user.username).replace(/[^\w -]/g, "");
        css += `.rc-fg-${h}{border-color:${rec.user.color}!important}`;
        css += `.rc-bg-${h}{background:${rec.user.color}!important}`;
        css += `.rc-label-${h}::after{content:"${name}";background:${rec.user.color};font-size:9px;padding:0 4px;border-radius:3px;color:#fff;margin-left:1px;vertical-align:1px}`;
      }
      if (styleElRef.current) styleElRef.current.textContent = css;
      updateRemoteCursors();
    });
    return off;
  }, [updateRemoteCursors]);

  const handleEditorMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    monaco.editor.defineTheme("iw-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#10141d",
        "editorGutter.background": "#10141d",
        "editor.lineHighlightBackground": "#161b26",
        "editorLineNumber.foreground": "#3a455e",
        "editorCursor.foreground": "#10b981",
      },
    });
    monaco.editor.setTheme("iw-dark");

    // local edits → TextOps → OT pipeline
    editor.onDidChangeModelContent((evt) => {
      if (applyingRef.current) return;
      const model = editor.getModel();
      const docId = findDocIdByModel(model, modelsRef.current);
      if (!docId) return;
      const state = useCode.getState().getDocState(docId);
      if (!state) return;
      // Build ONE TextOperation over the PRE-EVENT document. evt.changes
      // offsets are all relative to that document — submitting them as
      // sequential ops corrupts every change after the first (the earlier
      // ops shift the offsets). Monaco guarantees non-overlapping, ordered
      // changes, so a single walk composes them exactly.
      const preLen = evt.changes.reduce(
        (len, ch) => len - ch.text.length + ch.rangeLength,
        model.getValueLength()
      );
      const op = new TextOperation();
      let prevEnd = 0;
      for (const change of evt.changes) {
        op.retain(change.rangeOffset - prevEnd);
        if (change.rangeLength) op.delete(change.rangeLength);
        if (change.text) op.insert(change.text);
        prevEnd = change.rangeOffset + change.rangeLength;
      }
      op.retain(preLen - prevEnd);
      if (!op.isNoop()) useCode.getState().submitLocal(docId, op);
    });

    // cursor presence inside the editor
    editor.onDidChangeCursorPosition(() => {
      const model = editor.getModel();
      const docId = findDocIdByModel(model, modelsRef.current);
      if (!docId) return;
      const pos = editor.getPosition();
      const sel = editor.getSelection();
      const offset = model.getOffsetAt(pos);
      const anchor = model.getOffsetAt({
        lineNumber: sel.startLineNumber,
        column: sel.startColumn,
      });
      sendPresence({ editor: { fileId: docId, offset, anchor }, view: "code" });
    });

    // OT-aware undo/redo (Monaco's built-in stack is disabled for the
    // document ops; intercept the keybindings)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () => {
      const docId = useCode.getState().activeDocId;
      if (!docId) return;
      const op = useCode.getState().undoDoc(docId);
      if (op) applyLocalOpToEditor(editor, monaco, op);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => {
      const docId = useCode.getState().activeDocId;
      if (!docId) return;
      const op = useCode.getState().redoDoc(docId);
      if (op) applyLocalOpToEditor(editor, monaco, op);
    });

    // Monaco loads async — the model-setup effect may have run before the
    // editor existed; run it now that we have the instance.
    if (setupModelRef.current) setupModelRef.current();
  };

  function applyLocalOpToEditor(editor, monaco, op) {
    const model = editor.getModel();
    applyingRef.current = true;
    try {
      applyTextOpToModel(monaco, model, op);
    } catch {}
    applyingRef.current = false;
  }

  // Bind the per-document model to the editor. Runs BOTH from the effect
  // (tab switch) and from handleEditorMount — Monaco loads asynchronously, so
  // onMount may fire after the effect has already run with null refs.
  const setupModel = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const st = useCode.getState();
    const doc = st.docs.find((d) => d.id === st.activeDocId);
    if (!doc) return;
    let model = modelsRef.current.get(doc.id);
    // @monaco-editor/react disposes models when the editor unmounts (e.g. the
    // last tab closes after a file delete/rename). A cached disposed model
    // throws "Model is disposed!" on access — replace it instead of reusing.
    if (model) {
      try {
        model.getValue();
      } catch {
        modelsRef.current.delete(doc.id);
        model = null;
      }
    }
    if (!model) {
      model = monaco.editor.createModel(doc.content, languageOf(doc.path));
      modelsRef.current.set(doc.id, model);
    }
    // sync model with the OT state (may have been resynced)
    const state = st.getDocState(doc.id);
    if (state && model.getValue() !== state.content && !state.outstanding) {
      applyingRef.current = true;
      model.setValue(state.content);
      applyingRef.current = false;
    }
    if (editor.getModel() !== model) editor.setModel(model);
    editor.updateOptions({ readOnly: st.role === "viewer" });
    updateRemoteCursors();
  }, [updateRemoteCursors]);

  // Indirection so the imperative mount hook can call the memoized setup
  // without breaking the React compiler's memoization analysis.
  const setupModelRef = useRef(null);
  useEffect(() => {
    setupModelRef.current = setupModel;
  }, [setupModel]);

  // switch models when the active tab changes
  useEffect(() => {
    setupModel();
  }, [activeDocId, activeDoc, role, setupModel]);

  // doc resync events → reload model content
  useEffect(() => {
    const handler = (evt) => {
      const { docId } = evt.detail || {};
      const model = modelsRef.current.get(docId);
      const state = useCode.getState().getDocState(docId);
      if (model && state) {
        applyingRef.current = true;
        model.setValue(state.content);
        applyingRef.current = false;
      }
    };
    window.addEventListener("iw-doc-reset", handler);
    // after a reconnect/stall recovery the OT state may include remote ops
    // the model never saw — re-sync it from the authoritative state
    window.addEventListener("iw-doc-recovered", handler);
    return () => {
      window.removeEventListener("iw-doc-reset", handler);
      window.removeEventListener("iw-doc-recovered", handler);
    };
  }, []);

  // (per-user label styles are injected by the presence:state handler)

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#10141d]">
      {/* tabs */}
      <div className="flex items-stretch border-b border-[#232b3b] overflow-x-auto flex-none">
        {openTabs.length === 0 && (
          <div className="px-3 py-2 text-xs text-[#5b6478]">No tabs open</div>
        )}
        {openTabs.map((id) => {
          const doc = docs.find((d) => d.id === id);
          if (!doc) return null;
          const active = id === activeDocId;
          return (
            <div
              key={id}
              className={`flex items-center gap-1.5 pl-3 pr-1.5 py-2 text-xs border-r border-[#232b3b] cursor-pointer whitespace-nowrap ${
                active ? "bg-[#161b26] text-[#e6e9ef]" : "text-[#8b94a7] hover:text-[#cbd2e0]"
              }`}
              onClick={() => openDoc(id)}
            >
              <span className="truncate max-w-40">{doc.path}</span>
              <button
                className="p-0.5 rounded hover:bg-[#232b3b]"
                onClick={(ev) => {
                  ev.stopPropagation();
                  closeDoc(id);
                }}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>

      {/* editor */}
      <div className="flex-1 min-h-0">
        {activeDocId ? (
          <Editor
            height="100%"
            theme="iw-dark"
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              padding: { top: 10 },
              renderWhitespace: "none",
              readOnly: role === "viewer",
              // built-in undo/redo is replaced by OT-aware undo
              undoStackSize: 0,
            }}
            onMount={handleEditorMount}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-1 px-6 text-center">
            <span className="text-sm text-[#cbd2e0]">No file open</span>
            <span className="text-xs text-[#5b6478]">Pick a file from the explorer, or create one with the + buttons.</span>
          </div>
        )}
      </div>
    </div>
  );
}

function findDocIdByModel(model, models) {
  for (const [id, m] of models) if (m === model) return id;
  return null;
}

// Apply a TextOperation to a Monaco model (guard against content events is
// handled by the caller via applyingRef).
function applyTextOpToModel(monaco, model, op) {
  const edits = [];
  let offset = 0;
  for (const component of op.ops) {
    if (TextOperation.isRetain(component)) {
      offset += component;
    } else if (TextOperation.isInsert(component)) {
      const pos = model.getPositionAt(offset);
      edits.push({
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        text: component,
        forceMoveMarkers: true,
      });
    } else {
      const start = model.getPositionAt(offset);
      const end = model.getPositionAt(offset + -component);
      edits.push({
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        text: "",
      });
      offset += -component;
      continue;
    }
  }
  if (edits.length) model.applyEdits(edits);
}

// stable short hash of a color string → css-safe class suffix
function hashColor(color) {
  let h = 0;
  for (let i = 0; i < color.length; i++) h = (h * 31 + color.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
