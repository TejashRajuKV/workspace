"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { InfiniteBoard } from "./InfiniteBoardLogo";

export default function AuthView({ onAuthed, onBack, initialMode = "login" }) {
  const [mode, setMode] = useState(initialMode);
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
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_1fr] bg-[#170d12]">
      {/* artwork side */}
      <aside className="relative hidden lg:block overflow-hidden border-r border-[#43272e]">
        <div className="landing-hero-art absolute inset-0" />
        <div
          aria-hidden
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: 'url("/landing-hero.jpg")' }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#170d12] via-[#170d12]/15 to-transparent" />
        <div className="relative z-10 flex h-full flex-col p-10">
          <div className="flex items-center gap-2.5 text-[#fff4e2]">
            <InfiniteBoard size={30} />
            <span className="font-semibold">Infinite Workspace</span>
          </div>
          <div className="mt-auto max-w-md">
            <h2 className="font-display text-4xl leading-tight text-[#fff4e2] drop-shadow-lg">
              Your ideas.
              <br />
              Your code.
              <br />
              <em className="italic text-[#f6c177]">One endless canvas.</em>
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-[#f3ddc9]/85">
              A multiplayer whiteboard, a live code editor and a terminal — together, in real time.
            </p>
          </div>
        </div>
      </aside>

      {/* form side */}
      <main className="flex flex-col items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center justify-between">
            <button
              className="btn px-2 py-1.5 text-xs text-[#c3a596] hover:bg-[#332026] hover:text-[#fbeeda]"
              onClick={onBack}
              type="button"
            >
              <ArrowLeft size={14} /> Back home
            </button>
            <span className="lg:hidden flex items-center gap-2 text-[#fbeeda]">
              <InfiniteBoard size={22} />
              <span className="text-sm font-semibold">Infinite Workspace</span>
            </span>
          </div>

          <h1 className="font-display text-3xl text-[#fff4e2]">
            {mode === "login" ? "Welcome back." : "Start creating."}
          </h1>
          <p className="mt-2 text-sm text-[#c3a596]">
            {mode === "login"
              ? "Sign in to open your boards and workspaces."
              : "One account, unlimited boards and shared code."}
          </p>

          <form
            onSubmit={submit}
            aria-busy={busy}
            className="mt-7 space-y-4 rounded-2xl border border-[#43272e] bg-[#201317] p-5"
          >
            <div className="flex rounded-lg bg-[#170d12] p-1 text-xs font-medium">
              {["login", "register"].map((m) => (
                <button
                  type="button"
                  key={m}
                  className={`flex-1 py-1.5 rounded-md transition-colors ${
                    mode === m
                      ? "bg-[#332026] text-[#fbeeda] shadow-sm ring-1 ring-[#553038]"
                      : "text-[#a1847a] hover:text-[#fbeeda]"
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
              <label className="text-xs text-[#c3a596] block mb-1">Username</label>
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
              <label className="text-xs text-[#c3a596] block mb-1">Password</label>
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
              <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-md px-3 py-2">
                {error}
              </div>
            )}

            <button type="submit" className="btn btn-primary w-full py-2.5" disabled={busy}>
              {busy ? "…" : mode === "login" ? "Sign in" : "Create account & start"}
            </button>

            <p className="text-[11px] text-[#a1847a] leading-relaxed text-center pt-1">
              Open this page in two browsers with different accounts, join the same workspace and
              watch cursors, shapes and code sync live.
            </p>
          </form>
        </div>
      </main>
    </div>
  );
}
