"use client";

// Collaborative code editor panel: Monaco + tabs + remote cursors.
// Monaco is vendored locally (public/monaco) so the app is fully self-hosted.

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Editor, { loader } from "@monaco-editor/react";
import { Eye, History, Pencil, Search, Settings2, X } from "lucide-react";
import { useCode } from "@/state/code";
import { useBoard, sendPresence } from "@/state/board";
import { on } from "@/lib/socket";
import { languageOf } from "@/lib/language";
import { renderMarkdown } from "@/lib/markdown";
import TextOperation from "@/shared/ot";
import SearchPanel from "./SearchPanel";
import FileHistoryDialog from "./FileHistoryDialog";

loader.config({ paths: { vs: "/monaco/vs" } });

const remotesRef = { users: new Map() }; // userId → {name, color, fileId, offset, anchor}
const SETTINGS_KEY = "iw.editor.settings.v1";
const DEFAULT_SETTINGS = { fontSize: 13, wordWrap: false, minimap: false };

function readSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export default function CodePanel({ onRunFile }) {
  const docs = useCode((s) => s.docs);
  const openTabs = useCode((s) => s.openTabs);
  const activeDocId = useCode((s) => s.activeDocId);
  const openDoc = useCode((s) => s.openDoc);
  const closeDoc = useCode((s) => s.closeDoc);
  const role = useBoard((s) => s.role);
  const workspaceId = useBoard((s) => s.wsId);

  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const modelsRef = useRef(new Map()); // docId → monaco model
  const applyingRef = useRef(false);
  const revealRef = useRef(null); // { docId, line } pending scroll-to-line
  const activeDoc = docs.find((d) => d.id === activeDocId);
  const isMarkdown = /\.(md|markdown)$/i.test(activeDoc?.path || "");
  const [preview, setPreview] = useState(false);
  const fsTick = useCode((s) => s.fsTick);

  // live document text (OT state wins over the last bootstrap snapshot)
  const liveText = useMemo(() => {
    const state = useCode.getState().getDocState(activeDocId);
    return state?.content ?? activeDoc?.content ?? "";
  }, [activeDocId, activeDoc, fsTick]);

  const previewHtml = useMemo(
    () => (preview && isMarkdown ? renderMarkdown(liveText) : ""),
    [preview, isMarkdown, liveText]
  );
  const [showSearch, setShowSearch] = useState(false);
  const [historyDocId, setHistoryDocId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(readSettings);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings]);

  useEffect(() => {
    const onHistory = (e) => {
      const docId = e.detail?.docId;
      if (docId) setHistoryDocId(docId);
    };
    const onReveal = (e) => {
      const { docId, line } = e.detail || {};
      if (!docId) return;
      revealRef.current = { docId, line: line || 1 };
      useCode.getState().openDoc(docId);
    };
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    window.addEventListener("iw-open-history", onHistory);
    window.addEventListener("iw-reveal-line", onReveal);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("iw-open-history", onHistory);
      window.removeEventListener("iw-reveal-line", onReveal);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

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
        "editor.background": "#201317",
        "editorGutter.background": "#201317",
        "editor.lineHighlightBackground": "#2a181d",
        "editorLineNumber.foreground": "#7a5a52",
        "editorLineNumber.activeForeground": "#f6c177",
        "editorCursor.foreground": "#f4a261",
        "editor.selectionBackground": "#7a4a3a66",
        "editor.inactiveSelectionBackground": "#7a4a3a33",
        "editor.selectionHighlightBackground": "#7a4a3a44",
        "editorWidget.background": "#2a181d",
        "editorWidget.border": "#43272e",
        "editorSuggestWidget.background": "#2a181d",
        "editorHoverWidget.background": "#2a181d",
        "editorIndentGuide.background1": "#3a252b",
        "editorIndentGuide.activeBackground1": "#5a3a3a",
        "editorWhitespace.foreground": "#3a252b",
        "scrollbarSlider.background": "#4a2c3380",
        "scrollbarSlider.hoverBackground": "#65394180",
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
    if (revealRef.current && revealRef.current.docId === doc.id) {
      const line = revealRef.current.line;
      revealRef.current = null;
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.focus();
    }
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
    <div className="flex flex-col h-full min-h-0 bg-[#201317]">
      {/* tabs */}
      <div className="flex items-stretch border-b border-[#43272e] flex-none">
        <div className="flex items-stretch overflow-x-auto flex-1 min-w-0">
          {openTabs.length === 0 && (
            <div className="px-3 py-2 text-xs text-[#a1847a]">No tabs open</div>
          )}
          {openTabs.map((id) => {
            const doc = docs.find((d) => d.id === id);
            if (!doc) return null;
            const active = id === activeDocId;
            return (
              <div
                key={id}
                className={`flex items-center gap-1.5 pl-3 pr-1.5 py-2 text-xs border-r border-[#43272e] cursor-pointer whitespace-nowrap ${
                  active ? "bg-[#2a181d] text-[#fbeeda]" : "text-[#c3a596] hover:text-[#f3ddc9]"
                }`}
                onClick={() => openDoc(id)}
              >
                <span className="truncate max-w-40">{doc.path}</span>
                <button
                  className="p-0.5 rounded hover:bg-[#43272e]"
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
        <div className="flex items-center gap-0.5 px-1.5 border-l border-[#43272e] flex-none">
          <button
            className="p-1.5 rounded text-[#c3a596] hover:text-amber-400 hover:bg-[#332026]"
            title="Search in files (Ctrl+Shift+F)"
            onClick={() => setShowSearch((v) => !v)}
          >
            <Search size={14} />
          </button>
          <button
            className="p-1.5 rounded text-[#c3a596] hover:text-amber-400 hover:bg-[#332026] disabled:opacity-40"
            title="File history"
            onClick={() => activeDocId && setHistoryDocId(activeDocId)}
            disabled={!activeDocId}
          >
            <History size={14} />
          </button>
          {isMarkdown && (
            <button
              className={`p-1.5 rounded hover:bg-[#332026] ${preview ? "text-amber-400" : "text-[#c3a596] hover:text-amber-400"}`}
              title={preview ? "Edit markdown" : "Preview markdown"}
              onClick={() => setPreview((v) => !v)}
            >
              {preview ? <Pencil size={14} /> : <Eye size={14} />}
            </button>
          )}
          <div className="relative">
            <button
              className="p-1.5 rounded text-[#c3a596] hover:text-amber-400 hover:bg-[#332026]"
              title="Editor settings"
              onClick={(e) => {
                e.stopPropagation();
                setShowSettings((v) => !v);
              }}
            >
              <Settings2 size={14} />
            </button>
            {showSettings && (
              <div
                className="absolute right-0 top-full mt-1 z-50 w-52 rounded-md border border-[#43272e] bg-[#2a181d] shadow-xl p-3 text-xs space-y-2"
                onClick={(e) => e.stopPropagation()}
              >
                <label className="flex items-center justify-between gap-2 text-[#c3a596]">
                  Font size
                  <input
                    type="number"
                    min="10"
                    max="24"
                    className="w-14 rounded border border-[#43272e] bg-[#1c1015] px-1.5 py-0.5 text-[#fbeeda]"
                    value={settings.fontSize}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        fontSize: Math.min(24, Math.max(10, Number(e.target.value) || 13)),
                      }))
                    }
                  />
                </label>
                <label className="flex items-center gap-2 text-[#c3a596] cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-amber-500"
                    checked={settings.wordWrap}
                    onChange={(e) => setSettings((s) => ({ ...s, wordWrap: e.target.checked }))}
                  />
                  Word wrap
                </label>
                <label className="flex items-center gap-2 text-[#c3a596] cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-amber-500"
                    checked={settings.minimap}
                    onChange={(e) => setSettings((s) => ({ ...s, minimap: e.target.checked }))}
                  />
                  Minimap
                </label>
              </div>
            )}
          </div>
        </div>
      </div>

      {showSearch && <SearchPanel open={showSearch} onClose={() => setShowSearch(false)} />}

      {/* editor */}
      <div className="flex-1 min-h-0">
        {activeDocId && previewHtml ? (
          <div
            className="h-full overflow-y-auto px-5 py-4 md-preview"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : activeDocId ? (
          <Editor
            height="100%"
            theme="iw-dark"
            options={{
              fontSize: settings.fontSize,
              wordWrap: settings.wordWrap ? "on" : "off",
              minimap: { enabled: settings.minimap },
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
            <span className="text-sm text-[#f3ddc9]">No file open</span>
            <span className="text-xs text-[#a1847a]">Pick a file from the explorer, or create one with the + buttons.</span>
          </div>
        )}
      </div>

      <FileHistoryDialog
        workspaceId={workspaceId}
        docId={historyDocId}
        open={!!historyDocId}
        onClose={() => setHistoryDocId(null)}
      />
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
