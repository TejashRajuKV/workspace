import { OBJECT_TYPES, OP, newObjectId } from "@/shared/protocol";
import { useBoard } from "@/state/board";
import { buildHistoryEntry } from "./history";

// Re-create exported canvas objects as local CREATE operations. New ids are
// minted so imports never collide with existing objects.
export function importCanvasObjects(objects) {
  const state = useBoard.getState();
  if (!state.wsId || state.role === "viewer") {
    return { added: 0, skipped: (objects || []).length, reason: "Read-only" };
  }
  let maxZ = 0;
  for (const obj of state.objects.values()) {
    if (typeof obj.z === "number" && obj.z > maxZ) maxZ = obj.z;
  }
  const ops = [];
  const entries = [];
  let skipped = 0;
  for (const raw of (objects || []).slice(0, 5000)) {
    if (!raw || !OBJECT_TYPES.includes(raw.type)) {
      skipped++;
      continue;
    }
    const id = newObjectId();
    const op = {
      type: OP.CREATE,
      oid: id,
      p: {
        object: {
          id,
          type: raw.type,
          z: (Number(raw.z) || 0) + maxZ + 1,
          payload: raw.payload || {},
        },
      },
    };
    const entry = buildHistoryEntry(state.objects, op);
    if (!entry) {
      skipped++;
      continue;
    }
    ops.push(op);
    entries.push(entry);
  }
  if (ops.length) state.submitOps(ops, entries);
  return { added: ops.length, skipped };
}
