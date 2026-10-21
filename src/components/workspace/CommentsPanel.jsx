"use client";

// Board comments: comment pins are ordinary canvas objects (type "comment")
// synchronized through the same op pipeline, so threads converge for every
// collaborator. This panel is the reading/writing surface for those threads.

import { useEffect, useMemo, useRef, useState } from "react";
import { X, Check, CheckCircle2, Trash2, Send, Locate, MessageSquarePlus } from "lucide-react";
import { useBoard, boardRefs, sendPresence } from "@/state/board";
import { OP, newCommentEntryId } from "@/shared/protocol";
import { buildHistoryEntry } from "./canvas-engine/history";
import { toast } from "./Feedback";

export default function CommentsPanel({ workspaceId, onClose }) {
  // objectCountTick forces a re-render when the objects Map mutates in place
  const tick = useBoard((s) => s.objectCountTick);
  const role = useBoard((s) => s.role);
  const me = useBoard((s) => s.me);
  const activeId = useBoard((s) => s.activeCommentId);
  const objects = useBoard((s) => s.objects);
  const [showResolved, setShowResolved] = useState(false);

  const comments = useMemo(() => {
    const list = [];
    for (const obj of objects.values()) {
      if (obj.type !== "comment") continue;
      const resolved = obj.payload?.data?.resolved === true;
      if (resolved && !showResolved) continue;
      list.push(obj);
    }
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  }, [objects, tick, showResolved]);

  const total = useMemo(() => {
    let n = 0;
    for (const obj of objects.values()) if (obj.type === "comment") n++;
    return n;
  }, [objects, tick]);

  const canEdit = role !== "viewer";

  useEffect(() => {
    sendPresence({ view: "board" });
  }, []);

  return (
    <aside className="w-80 flex-none border-l border-[#43272e] bg-[#1c1015] flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#43272e]">
        <span className="text-[11px] font-semibold tracking-wider text-[#c3a596] uppercase">
          Comments {total ? `(${total})` : ""}
        </span>
        <div className="flex items-center gap-1">
          <button
            title={showResolved ? "Hide resolved" : "Show resolved"}
            onClick={() => setShowResolved((v) => !v)}
            className={`p-1 rounded hover:bg-[#332026] ${showResolved ? "text-amber-400" : "text-[#c3a596]"}`}
          >
            <CheckCircle2 size={14} />
          </button>
          <button className="p-1 rounded hover:bg-[#332026] text-[#c3a596]" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
        {!comments.length && (
          <div className="text-xs text-[#c3a596] px-2 py-3 leading-relaxed">
            No open comments. Pick the{" "}
            <span className="text-[#fbeeda] inline-flex items-center gap-1">
              <MessageSquarePlus size={12} /> comment tool (M)
            </span>{" "}
            and click the board to drop a pin. Use @username to notify teammates.
          </div>
        )}
        {comments.map((obj) => (
          <CommentCard
            key={obj.id}
            obj={obj}
            workspaceId={workspaceId}
            canEdit={canEdit}
            me={me}
            highlighted={obj.id === activeId}
          />
        ))}
      </div>

      <div className="px-3 py-2 border-t border-[#43272e] text-[10px] text-[#a1847a] leading-relaxed">
        Comment pins sync live with the board. Reply or resolve anything you can
        see; teammates get notified on replies and @mentions.
      </div>
    </aside>
  );
}

function CommentCard({ obj, workspaceId, canEdit, me, highlighted }) {
  const data = obj.payload?.data || {};
  const thread = Array.isArray(data.thread) ? data.thread : [];
  const resolved = data.resolved === true;
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState(data.text || "");
  const [editingSubject, setEditingSubject] = useState(false);
  const cardRef = useRef(null);

  useEffect(() => {
    if (highlighted && cardRef.current) cardRef.current.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const submitOp = (op) => {
    const s = useBoard.getState();
    const entry = buildHistoryEntry(s.objects, op);
    s.submitOps([op], entry ? [entry] : undefined);
  };

  const reply = () => {
    const text = body.trim();
    if (!text) return;
    // author fields are filled server-side; including them here keeps the
    // optimistic local echo from showing a placeholder name.
    submitOp({
      type: OP.COMMENT,
      oid: obj.id,
      p: {
        action: "reply",
        entry: { id: newCommentEntryId(), body: text, authorId: me?.id, authorName: me?.username },
      },
    });
    setBody("");
    sendPresence({ typing: false });
  };

  const toggleResolved = () => {
    submitOp({ type: OP.COMMENT, oid: obj.id, p: { action: "resolve", resolved: !resolved } });
  };

  const saveSubject = () => {
    setEditingSubject(false);
    const next = subject.trim();
    if ((data.text || "") === next) return;
    submitOp({ type: OP.COMMENT, oid: obj.id, p: { action: "edit", text: next } });
  };

  const remove = () => {
    submitOp({ type: OP.DELETE, oid: obj.id, p: {} });
    toast("Comment deleted", "success");
  };

  const locate = () => {
    const s = useBoard.getState();
    s.setSelection([obj.id]);
    sendPresence({ selection: [obj.id] });
    const canvas = document.querySelector("canvas");
    if (canvas) {
      const p = obj.payload;
      const centerX = p.x + 14;
      const centerY = p.y + 14;
      s.setCamera({
        zoom: Math.max(s.camera.zoom, 1),
        x: centerX - canvas.clientWidth / (2 * Math.max(s.camera.zoom, 1)),
        y: centerY - canvas.clientHeight / (2 * Math.max(s.camera.zoom, 1)),
      });
    }
    boardRefs.renderTick += 1;
    useBoard.getState().setActiveComment(obj.id);
  };

  const fmt = (ts) => {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return "";
    }
  };

  return (
    <div
      ref={cardRef}
      onMouseEnter={() => useBoard.getState().setActiveComment(obj.id)}
      className={`rounded-lg border p-2.5 transition-colors ${
        highlighted ? "border-amber-500/60 bg-[#2a181d]" : "border-[#43272e] bg-[#201317]"
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className="w-5 h-5 flex-none rounded-full flex items-center justify-center text-[10px] font-bold text-white mt-0.5"
          style={{ background: resolved ? "#9ca3af" : "#e76f51" }}
        >
          {thread.length || "+"}
        </span>
        <div className="min-w-0 flex-1">
          {editingSubject ? (
            <input
              autoFocus
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onBlur={saveSubject}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") saveSubject();
                if (e.key === "Escape") {
                  setSubject(data.text || "");
                  setEditingSubject(false);
                }
              }}
              placeholder="Comment subject…"
              className="w-full bg-[#170d12] border border-[#43272e] rounded px-1.5 py-1 text-xs text-[#fbeeda] outline-none focus:border-amber-500"
            />
          ) : (
            <button
              disabled={!canEdit}
              onClick={() => {
                if (!canEdit) return;
                setSubject(data.text || "");
                setEditingSubject(true);
              }}
              className={`text-left text-xs w-full truncate ${
                data.text ? "text-[#fbeeda]" : "text-[#a1847a] italic"
              }`}
              title={canEdit ? "Click to rename this comment" : ""}
            >
              {data.text || "Untitled comment"}
            </button>
          )}
          <div className="text-[10px] text-[#a1847a] mt-0.5">
            {resolved ? "Resolved" : "Open"} · {thread.length} message{thread.length === 1 ? "" : "s"}
          </div>
        </div>
        <button title="Locate on board" onClick={locate} className="p-1 rounded hover:bg-[#332026] text-[#c3a596] flex-none">
          <Locate size={13} />
        </button>
      </div>

      {thread.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {thread.map((entry) => (
            <div key={entry.id} className="rounded-md bg-[#170d12] px-2 py-1.5">
              <div className="flex items-center gap-1.5 text-[10px] text-[#a1847a]">
                <span className="font-medium text-[#c3a596]">{entry.authorName || "someone"}</span>
                <span>·</span>
                <span>{fmt(entry.at)}</span>
                {me && entry.authorId === me.id && <span className="text-amber-400">· you</span>}
              </div>
              <div className="text-xs text-[#fbeeda] whitespace-pre-wrap break-words mt-0.5">{entry.body}</div>
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <div className="mt-2 flex items-end gap-1.5">
          <textarea
            rows={1}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              sendPresence({ typing: !!e.target.value });
            }}
            onBlur={() => sendPresence({ typing: false })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                reply();
              }
            }}
            placeholder={thread.length ? "Reply… (@ to mention)" : "Add a comment… (@ to mention)"}
            className="flex-1 min-w-0 resize-none bg-[#170d12] border border-[#43272e] rounded-md px-2 py-1.5 text-xs text-[#fbeeda] outline-none focus:border-amber-500 placeholder:text-[#7a625a]"
          />
          <button
            title="Send (Enter)"
            disabled={!body.trim()}
            onClick={reply}
            className="btn btn-primary px-2 py-1.5 disabled:opacity-40"
          >
            <Send size={13} />
          </button>
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-1">
        <button
          disabled={!canEdit}
          onClick={toggleResolved}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] disabled:opacity-40 ${
            resolved ? "text-[#a1847a] hover:bg-[#332026]" : "text-emerald-400 hover:bg-[#332026]"
          }`}
        >
          {resolved ? <Check size={11} /> : <CheckCircle2 size={11} />}
          {resolved ? "Reopen" : "Resolve"}
        </button>
        <div className="flex-1" />
        <button
          disabled={!canEdit}
          onClick={remove}
          title="Delete comment"
          className="p-1 rounded text-red-400 hover:bg-[#332026] disabled:opacity-40"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
