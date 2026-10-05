"use client";

// In-app replacements for the browser's blocking alert / confirm / prompt,
// plus transient toasts. Call `toast()`, `confirmDialog()` or `promptDialog()`
// from anywhere (event handlers, stores) — <FeedbackHost /> renders them.

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { X, CheckCircle2, AlertTriangle, Info } from "lucide-react";

const useFeedback = create((set) => ({
  toasts: [],
  dialog: null, // { kind, title, message, defaultValue, confirmLabel, danger, resolve }
}));

let toastSeq = 0;

export function toast(message, kind = "info", ms = 4000) {
  if (!message) return;
  const id = ++toastSeq;
  useFeedback.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, kind }] }));
  setTimeout(() => dismissToast(id), ms);
}

function dismissToast(id) {
  useFeedback.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

function openDialog(spec) {
  return new Promise((resolve) => {
    // a dialog opened over another one cancels the earlier one
    const prev = useFeedback.getState().dialog;
    prev?.resolve(prev.kind === "prompt" ? null : false);
    useFeedback.setState({ dialog: { ...spec, resolve, id: ++toastSeq } });
  });
}

export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return openDialog({ kind: "confirm", title, message, confirmLabel, danger });
}

// resolves to the entered string, or null when cancelled
export function promptDialog({ title, message, defaultValue = "", placeholder = "", confirmLabel = "OK" }) {
  return openDialog({ kind: "prompt", title, message, defaultValue, placeholder, confirmLabel });
}

const TOAST_STYLE = {
  info: { Icon: Info, cls: "text-sky-400" },
  success: { Icon: CheckCircle2, cls: "text-emerald-400" },
  error: { Icon: AlertTriangle, cls: "text-red-400" },
};

function Dialog({ dialog }) {
  const [value, setValue] = useState(dialog.defaultValue || "");
  const inputRef = useRef(null);
  const isPrompt = dialog.kind === "prompt";

  const close = (result) => {
    useFeedback.setState({ dialog: null });
    dialog.resolve(result);
  };

  useEffect(() => {
    if (isPrompt) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    const onKey = (e) => {
      if (e.key === "Escape") close(isPrompt ? null : false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (e) => {
    e.preventDefault();
    if (isPrompt) {
      const v = value.trim();
      close(v ? v : null);
    } else close(true);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && close(isPrompt ? null : false)}
    >
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        className="w-full max-w-sm rounded-xl border border-[#232b3b] bg-[#10141d] p-5 shadow-2xl"
      >
        <h3 className="text-sm font-semibold text-[#e6e9ef]">{dialog.title}</h3>
        {dialog.message && (
          <p className="mt-1.5 text-xs text-[#8b94a7] leading-relaxed whitespace-pre-line">{dialog.message}</p>
        )}
        {isPrompt && (
          <input
            ref={inputRef}
            className="field mt-3"
            value={value}
            placeholder={dialog.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost px-3 py-1.5" onClick={() => close(isPrompt ? null : false)}>
            Cancel
          </button>
          <button
            type="submit"
            autoFocus={!isPrompt}
            className={`btn px-3.5 py-1.5 ${dialog.danger ? "bg-red-600 text-white hover:bg-red-500" : "btn-primary"}`}
            disabled={isPrompt && !value.trim()}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function FeedbackHost() {
  const toasts = useFeedback((s) => s.toasts);
  const dialog = useFeedback((s) => s.dialog);
  return (
    <>
      {dialog && <Dialog key={dialog.id} dialog={dialog} />}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[110] flex flex-col items-center gap-2 pointer-events-none px-4">
        {toasts.map((t) => {
          const { Icon, cls } = TOAST_STYLE[t.kind] || TOAST_STYLE.info;
          return (
            <div
              key={t.id}
              role="status"
              className="pointer-events-auto flex items-center gap-2.5 max-w-md rounded-lg bg-[#161b26] border border-[#232b3b] pl-3 pr-2 py-2 text-sm text-[#e6e9ef] shadow-xl"
            >
              <Icon size={15} className={`flex-none ${cls}`} />
              <span className="min-w-0">{t.message}</span>
              <button
                className="p-1 rounded text-[#5b6478] hover:text-white hover:bg-[#232b3b]"
                onClick={() => dismissToast(t.id)}
                aria-label="Dismiss"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
