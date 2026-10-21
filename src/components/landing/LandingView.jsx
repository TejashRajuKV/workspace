"use client";

// Marketing landing page. Shown to signed-out visitors before auth; the hero
// uses public/landing-hero.jpg (the sunset windmill artwork) with a vector
// fallback so the page still renders before the asset is dropped in.

import {
  ArrowRight,
  Code2,
  FolderTree,
  MousePointer2,
  PenTool,
  Play,
  Sparkles,
  SquareTerminal,
  Users,
  Zap,
} from "lucide-react";
import { InfiniteBoard } from "@/components/workspace/InfiniteBoardLogo";

const FEATURES = [
  {
    icon: PenTool,
    title: "Infinite whiteboard",
    body: "Sticky notes, shapes, arrows and freehand — pan and zoom forever while everyone’s cursors move in real time.",
  },
  {
    icon: Code2,
    title: "Code together",
    body: "A Monaco editor with operational-transform sync, shared tabs, remote selections and per-user undo.",
  },
  {
    icon: SquareTerminal,
    title: "Run it instantly",
    body: "Execute JavaScript, TypeScript and Python in a sandboxed runner and watch output land in the built-in terminal.",
  },
  {
    icon: FolderTree,
    title: "Files travel with the board",
    body: "Create, upload, duplicate and download files and folders. Same workspace, same permissions, one click away.",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Create a workspace",
    body: "Name it, open it, and you get a board, a file tree and a terminal in one screen.",
  },
  {
    n: "02",
    title: "Share the ID",
    body: "Send the workspace ID to a teammate. They join in a click — no invites or installs.",
  },
  {
    n: "03",
    title: "Build together",
    body: "Sketch the plan, write the code beside it and run it live while everyone watches.",
  },
];

export default function LandingView({ onStart, onSignIn }) {
  return (
    <div className="min-h-screen bg-[#170d12] text-[#fbeeda] overflow-x-hidden">
      {/* ---------------- hero ---------------- */}
      <section className="relative min-h-[100svh] flex flex-col overflow-hidden">
        <div className="landing-hero-art absolute inset-0" />
        <div
          aria-hidden
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: 'url("/landing-hero.jpg")' }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#170d12]/55 via-[#170d12]/5 to-[#170d12]" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#170d12]/85 via-[#170d12]/30 to-transparent" />
        <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-[#170d12]/80 to-transparent" />

        <header className="relative z-20 flex items-center gap-3 px-5 sm:px-10 h-20">
          <InfiniteBoard size={34} />
          <div className="leading-tight">
            <span className="whitespace-nowrap text-sm font-semibold tracking-tight sm:text-base">
              Infinite Workspace
            </span>
            <span className="hidden sm:block text-[11px] text-[#f3ddc9]/70">
              whiteboard · code · terminal
            </span>
          </div>
          <nav className="ml-auto hidden md:flex items-center gap-7 text-sm text-[#f3ddc9]/80">
            <a href="#features" className="hover:text-[#fbeeda] transition-colors">
              Features
            </a>
            <a href="#how" className="hover:text-[#fbeeda] transition-colors">
              How it works
            </a>
            <a href="#start" className="hover:text-[#fbeeda] transition-colors">
              Get started
            </a>
          </nav>
          <div className="ml-auto md:ml-6 flex items-center gap-2">
            <div className="hidden sm:block">
              <button className="btn px-3.5 py-2 text-[#fbeeda]/90 hover:bg-white/10" onClick={onSignIn}>
                Sign in
              </button>
            </div>
            <button className="btn btn-primary px-4 py-2 shadow-lg shadow-[#e76f51]/20" onClick={onStart}>
              Start free <ArrowRight size={14} />
            </button>
          </div>
        </header>

        <div className="relative z-10 flex-1 flex items-end">
          <div className="w-full px-5 sm:px-10 pb-16 sm:pb-24">
            <div className="max-w-4xl">
              <span className="inline-flex items-center gap-2 rounded-full border border-[#f6c177]/35 bg-[#170d12]/45 px-3 py-1 text-[11px] font-medium tracking-wide text-[#f6c177] backdrop-blur-sm">
                <Sparkles size={12} /> Real-time · multiplayer · in your browser
              </span>
              <h1 className="font-display mt-5 text-5xl sm:text-6xl lg:text-7xl leading-[1.03] tracking-tight text-[#fff4e2] drop-shadow-[0_2px_30px_rgba(23,13,18,0.55)]">
                Your ideas.
                <br />
                Your code.
                <br />
                <em className="italic text-[#f6c177]">One endless canvas.</em>
              </h1>
              <p className="mt-5 max-w-xl text-base sm:text-lg text-[#f3ddc9]/85 leading-relaxed">
                Sketch the plan, write the code, run it together. Infinite Workspace pairs a
                multiplayer whiteboard with a live code editor and terminal — no tab-switching,
                no setup.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <button
                  className="btn btn-primary px-6 py-3 text-sm shadow-xl shadow-[#e76f51]/25"
                  onClick={onStart}
                >
                  Start creating — free <ArrowRight size={15} />
                </button>
                <button
                  className="btn px-5 py-3 text-sm border border-[#fbeeda]/25 bg-[#170d12]/35 text-[#fff4e2] backdrop-blur-sm hover:bg-[#170d12]/55"
                  onClick={onSignIn}
                >
                  <Play size={14} /> Sign in
                </button>
              </div>
              <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] uppercase tracking-[0.14em] text-[#f3ddc9]/60">
                <span className="flex items-center gap-1.5">
                  <Users size={12} /> Live cursors
                </span>
                <span className="flex items-center gap-1.5">
                  <Zap size={12} /> Instant sync
                </span>
                <span className="flex items-center gap-1.5">
                  <SquareTerminal size={12} /> JS · TS · Python
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- features ---------------- */}
      <section id="features" className="relative px-5 sm:px-10 py-20 sm:py-28 border-t border-[#43272e]/60">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl">
            <span className="text-[11px] font-semibold tracking-[0.2em] uppercase text-[#f6c177]">
              Everything in one place
            </span>
            <h2 className="font-display mt-3 text-3xl sm:text-4xl lg:text-5xl tracking-tight text-[#fff4e2]">
              A board, an editor and a terminal that actually talk to each other.
            </h2>
            <p className="mt-3 text-sm sm:text-base text-[#c3a596]">
              Stop pasting screenshots into chat. Think, build and verify without leaving the page.
            </p>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <article
                key={title}
                className="group relative rounded-2xl border border-[#43272e] bg-[#201317] p-6 transition-colors hover:border-[#f4a261]/50 hover:bg-[#251619]"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#f4a261]/25 to-[#e76f51]/10 text-[#f6c177] ring-1 ring-inset ring-[#f4a261]/20">
                    <Icon size={18} />
                  </span>
                  <h3 className="font-semibold tracking-tight text-[#fbeeda]">{title}</h3>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-[#c3a596]">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- showcase ---------------- */}
      <section className="px-5 sm:px-10 py-16 sm:py-24 border-y border-[#43272e]/60 bg-[#1c1015]">
        <div className="mx-auto max-w-6xl grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center">
          <div>
            <span className="text-[11px] font-semibold tracking-[0.2em] uppercase text-[#f6c177]">
              The workspace
            </span>
            <h2 className="font-display mt-3 text-3xl sm:text-4xl tracking-tight text-[#fff4e2]">
              From messy idea to working demo, side by side.
            </h2>
            <p className="mt-4 text-sm sm:text-base leading-relaxed text-[#c3a596]">
              Keep the sketch next to the code. Drag the divider to give the board more room, collapse
              the terminal when you don’t need it, and zoom to fit everything with one click.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-[#f3ddc9]/85">
              {[
                "Resizable board, code and terminal panes",
                "Live file tree with upload, duplicate and download",
                "Undo/redo that understands multi-object edits",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2.5">
                  <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-[#f4a261]" />
                  {line}
                </li>
              ))}
            </ul>
          </div>

          {/* stylized app preview */}
          <div className="relative">
            <div className="absolute -inset-6 rounded-[2rem] bg-[#e76f51]/10 blur-2xl" />
            <div className="relative overflow-hidden rounded-2xl border border-[#43272e] bg-[#170d12] shadow-2xl shadow-black/40">
              <div className="flex items-center gap-2 border-b border-[#43272e] px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#e76f51]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#f6c177]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#8f8a6a]" />
                <span className="ml-3 text-[11px] text-[#a1847a]">sprint-board · main.ts</span>
                <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[#f6c177]">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#f4a261]" /> live
                </span>
              </div>
              <div className="grid grid-cols-[1.15fr_1fr] min-h-[290px]">
                <div className="relative border-r border-[#43272e] bg-[#fff7ec] p-4">
                  <div className="absolute inset-0 opacity-40 [background-image:radial-gradient(#e3cbb2_1px,transparent_1px)] [background-size:14px_14px]" />
                  <div className="relative space-y-3">
                    <div className="w-32 rotate-[-2deg] rounded-sm bg-[#f6c177] p-2 text-[10px] font-medium text-[#3a2118] shadow">
                      ship the landing page 🌅
                    </div>
                    <div className="ml-16 w-28 rotate-[1.5deg] rounded-sm bg-[#f4a261] p-2 text-[10px] font-medium text-[#2a1208] shadow">
                      realtime cursors
                    </div>
                    <div className="ml-3 w-36 rotate-[1deg] rounded-sm bg-[#fbeeda] p-2 text-[10px] text-[#4a2c33] shadow ring-1 ring-[#43272e]/10">
                      draw the windmill
                    </div>
                    <div className="ml-24 h-14 w-24 rounded-md border-2 border-[#e76f51]/70" />
                  </div>
                  <span className="absolute right-5 top-16 rounded-full bg-[#e76f51] px-1.5 py-0.5 text-[8px] font-semibold text-white shadow">
                    maya
                  </span>
                </div>
                <div className="bg-[#201317] p-4 font-mono text-[10px] leading-relaxed text-[#f3ddc9]">
                  <div className="text-[#a1847a]">main.ts</div>
                  <div className="mt-2">
                    <span className="text-[#c792ea]">const</span> board ={" "}
                    <span className="text-[#f6c177]">createBoard</span>();
                  </div>
                  <div>
                    board.<span className="text-[#82d2c5]">on</span>(
                    <span className="text-[#f4a261]">"join"</span>, (user) =&gt; {"{"}
                  </div>
                  <div className="pl-4">
                    board.<span className="text-[#82d2c5]">sync</span>(user.cursor);
                  </div>
                  <div>{"});"}</div>
                  <div className="mt-3 text-[#a1847a]"># terminal</div>
                  <div className="text-[#f6c177]">$ node main.ts</div>
                  <div className="text-[#8fbf9f]">✓ synced 3 users in 12ms</div>
                  <div className="mt-1 inline-block h-3 w-1.5 animate-pulse bg-[#f4a261]" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- how it works ---------------- */}
      <section id="how" className="px-5 sm:px-10 py-20 sm:py-28">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <span className="text-[11px] font-semibold tracking-[0.2em] uppercase text-[#f6c177]">
                Three steps
              </span>
              <h2 className="font-display mt-3 text-3xl sm:text-4xl tracking-tight text-[#fff4e2]">
                Open a workspace. Share the ID. Go.
              </h2>
            </div>
            <p className="text-xs text-[#a1847a] flex items-center gap-1.5">
              <MousePointer2 size={13} /> No installs, no credit card
            </p>
          </div>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {STEPS.map((s) => (
              <div
                key={s.n}
                className="relative rounded-2xl border border-[#43272e] bg-[#201317] p-6"
              >
                <span className="font-display text-4xl text-[#f4a261]/35">{s.n}</span>
                <h3 className="mt-3 font-semibold text-[#fbeeda]">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#c3a596]">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- final CTA ---------------- */}
      <section id="start" className="px-5 sm:px-10 pb-20">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl border border-[#f4a261]/25 bg-gradient-to-br from-[#8f352b] via-[#b8452c] to-[#e76f51] px-6 py-14 sm:px-14 sm:py-20 text-center">
          <div className="pointer-events-none absolute -left-20 -top-24 h-72 w-72 rounded-full bg-[#ffe6a6]/35 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 right-0 h-80 w-80 rounded-full bg-[#7a1f1a]/40 blur-3xl" />
          <div className="relative">
            <h2 className="font-display text-3xl sm:text-5xl tracking-tight text-[#fff7ea]">
              Build something at golden hour.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm sm:text-base text-[#ffe6d3]/85">
              Your next idea deserves more than a chat thread. Open a canvas, invite a teammate and
              ship it.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <button
                className="btn bg-[#170d12] px-6 py-3 text-sm text-[#fbeeda] hover:bg-[#21151a]"
                onClick={onStart}
              >
                Create your workspace <ArrowRight size={15} />
              </button>
              <button
                className="btn border border-[#fff7ea]/40 px-5 py-3 text-sm text-[#fff7ea] hover:bg-white/10"
                onClick={onSignIn}
              >
                Sign in
              </button>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-[#43272e]/60 px-5 sm:px-10 py-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 text-xs text-[#a1847a]">
          <InfiniteBoard size={22} />
          <span className="text-[#f3ddc9]">Infinite Workspace</span>
          <span className="hidden sm:inline">·</span>
          <span>whiteboard + code, in real time</span>
          <div className="ml-auto flex items-center gap-5">
            <a href="#features" className="hover:text-[#fbeeda] transition-colors">
              Features
            </a>
            <a href="#how" className="hover:text-[#fbeeda] transition-colors">
              How it works
            </a>
            <button className="hover:text-[#fbeeda] transition-colors" onClick={onSignIn}>
              Sign in
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
