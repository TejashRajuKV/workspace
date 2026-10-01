"use client";

// Singleton Socket.IO connection to the collaboration service.
// The browser reaches it through the gateway with ?XTransformPort=3003 —
// never a direct port URL. Session identity rides on the httpOnly cookie.

import { io } from "socket.io-client";

let socket = null;
let connected = false;
const listeners = new Map(); // event → Set(fn)
const pendingAcks = []; // fns to call once the socket reconnects

export function getSocket() {
  if (socket) return socket;
  socket = io("/?XTransformPort=3003", {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 600,
    reconnectionDelayMax: 4000,
    timeout: 10000,
    forceNew: true,
  });

  if (typeof window !== "undefined") {
    // debugging / e2e hook
    try {
      window.__iwSocket = socket;
    } catch {}
  }

  socket.on("connect", () => {
    connected = true;
    emitLocal("connection", "online");
    for (const fn of pendingAcks.splice(0)) {
      try {
        fn();
      } catch {}
    }
  });
  socket.on("disconnect", (reason) => {
    connected = false;
    emitLocal("connection", "offline");
  });
  socket.on("connect_error", (err) => {
    const msg = String(err?.message || "");
    emitLocal("connect_error", msg);
  });

  return socket;
}

export function isConnected() {
  return connected;
}

export function onConnect(fn) {
  pendingAcks.push(fn);
  if (connected) fn();
}

// Subscribe to a socket event. Returns unsubscribe.
export function on(event, fn) {
  const s = getSocket();
  s.on(event, fn);
  return () => s.off(event, fn);
}

// Local (non-server) events about the connection itself
export function onLocal(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

function emitLocal(event, payload) {
  const set = listeners.get(event);
  if (set) for (const fn of set) fn(payload);
}

// Promise-style emit
export function emitAck(event, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const s = getSocket();
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ error: "timeout" });
      }
    }, timeoutMs);
    s.emit(event, payload, (res) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(res || {});
      }
    });
  });
}
