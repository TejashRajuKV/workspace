// ============================================================
// Presence: ephemeral, in-memory, never persisted.
// Server aggregates updates and broadcasts at a fixed rate (15 Hz max per
// room) so a storm of cursor movements costs one datagram per tick.
// ============================================================

const BROADCAST_INTERVAL_MS = 66; // ~15 Hz

// roomId → Map(socketId → presence record)
const rooms = new Map();
const dirty = new Set();
let timer = null;
let ioRef = null;

export function bindPresence(io) {
  ioRef = io;
  timer = setInterval(() => {
    for (const roomId of dirty) {
      const room = rooms.get(roomId);
      if (!room) continue;
      const users = {};
      for (const [sid, rec] of room) {
        users[sid] = {
          user: rec.user,
          cursor: rec.cursor,
          selection: rec.selection,
          view: rec.view,
          editor: rec.editor,
        };
      }
      ioRef.to(roomId).emit("presence:state", { users, exclude: [...room.keys()] });
    }
    dirty.clear();
  }, BROADCAST_INTERVAL_MS);
}

export function joinPresence(roomId, socketId, user) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  rooms.get(roomId).set(socketId, {
    user,
    cursor: null,
    selection: [],
    view: "board",
    editor: null,
  });
  dirty.add(roomId);
}

export function leavePresence(roomId, socketId) {
  const room = rooms.get(roomId);
  if (room) {
    room.delete(socketId);
    dirty.add(roomId);
    if (!room.size) rooms.delete(roomId);
  }
}

export function updatePresence(roomId, socketId, patch) {
  const room = rooms.get(roomId);
  const rec = room?.get(socketId);
  if (!rec) return;
  if ("cursor" in patch) rec.cursor = patch.cursor;
  if ("selection" in patch) rec.selection = Array.isArray(patch.selection) ? patch.selection.slice(0, 500) : [];
  if ("view" in patch) rec.view = patch.view;
  if ("editor" in patch) rec.editor = patch.editor;
  dirty.add(roomId);
}

export function presenceSnapshot(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return [...room.values()].map((r) => r.user);
}

export function roomSocketCount(roomId) {
  return rooms.get(roomId)?.size || 0;
}
