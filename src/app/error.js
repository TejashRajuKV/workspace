"use client";

// Route-level error boundary: a crash in any view (e.g. an unexpected
// disposed-editor edge) shows a recoverable screen instead of a blank page.

export default function GlobalError({ error, reset }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0b0e14] p-6">
      <div className="max-w-md w-full rounded-xl border border-[#232b3b] bg-[#10141d] p-6 text-center">
        <div className="text-3xl mb-2">⚠️</div>
        <h1 className="text-lg font-semibold text-[#e6e9ef] mb-1">Something went wrong</h1>
        <p className="text-sm text-[#8b94a7] mb-4 leading-relaxed">
          The workspace hit an unexpected error. Your work is saved on the
          server — reloading will restore your board and files.
        </p>
        <p className="text-[11px] text-[#5b6474] font-mono mb-5 break-all max-h-20 overflow-y-auto">
          {String(error?.message || error || "unknown error")}
        </p>
        <button
          className="btn btn-primary px-4 py-2 w-full"
          onClick={() => reset()}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
