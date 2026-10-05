"use client";

import { useState } from "react";
import { InfiniteBoard } from "./InfiniteBoardLogo";

export default function AuthView({ onAuthed }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong");
        return;
      }
      onAuthed(data.user);
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[#0b0e14]">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-7 justify-center">
          <InfiniteBoard size={30} />
          <div>
            <h1 className="text-lg font-bold text-[#e6e9ef] leading-tight">Infinite Workspace</h1>
            <p className="text-[11px] text-[#8b94a7]">whiteboard + collaborative code, in real time</p>
          </div>
        </div>

        <form onSubmit={submit} aria-busy={busy} className="rounded-xl border border-[#232b3b] bg-[#10141d] p-5 space-y-3.5">
          <div className="flex rounded-lg bg-[#0b0e14] p-1 text-xs font-medium">
            {["login", "register"].map((m) => (
              <button
                type="button"
                key={m}
                className={`flex-1 py-1.5 rounded-md transition-colors ${
                  mode === m ? "bg-[#1b2230] text-white shadow-sm ring-1 ring-[#2a3347]" : "text-[#8b94a7] hover:text-white"
                }`}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
              >
                {m === "login" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          <div>
            <label className="text-xs text-[#8b94a7] block mb-1">Username</label>
            <input
              className="field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. tejash"
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="text-xs text-[#8b94a7] block mb-1">Password</label>
            <input
              className="field"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "at least 6 characters" : "••••••••"}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              required
            />
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary w-full py-2" disabled={busy}>
            {busy ? "…" : mode === "login" ? "Sign in" : "Create account & start"}
          </button>

          <p className="text-[11px] text-[#5b6478] leading-relaxed text-center pt-1">
            Open this page in two browsers with different accounts, join the same
            workspace and watch cursors, shapes and code sync live.
          </p>
        </form>
      </div>
    </div>
  );
}
