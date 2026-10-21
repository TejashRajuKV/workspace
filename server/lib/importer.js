// Bulk file import used by ZIP import and GitHub pull.
//
// Conflicts are resolved with a per-import policy:
//   skip      → leave the existing file untouched (default)
//   overwrite → replace content (routed through OT when the collab service is up)
//   rename    → import beside the existing file with a " (2)" suffix

import { db } from "./db.js";
import { serviceClient } from "./serviceClient.js";
import { validateFilePath } from "../../src/shared/protocol.js";

const MAX_FILE_BYTES = 512 * 1024;

export async function ensureParentFolders(workspaceId, path, now) {
  const parts = path.split("/");
  parts.pop();
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const parent = await db.document.findUnique({
      where: { workspaceId_path: { workspaceId, path: prefix + "/" } },
    });
    if (!parent) {
      await db.document.create({
        data: {
          workspaceId,
          path: prefix + "/",
          isFolder: true,
          createdAt: BigInt(now),
          updatedAt: BigInt(now),
        },
      });
    } else if (parent.deleted) {
      // resurrect folders removed by an earlier delete so the tree stays whole
      await db.document.update({
        where: { id: parent.id },
        data: { deleted: false, isFolder: true, updatedAt: BigInt(now) },
      });
    }
  }
}

function withSuffix(path, n) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot > 0) return `${dir}${base.slice(0, dot)} (${n})${base.slice(dot)}`;
  return `${dir}${base} (${n})`;
}

export async function importFiles(workspaceId, files, { policy = "skip", userId = "" } = {}) {
  const now = Date.now();
  const rows = await db.document.findMany({
    where: { workspaceId },
    select: { path: true },
  });
  const taken = new Set(rows.map((r) => r.path));
  const summary = { total: files.length, created: 0, overwritten: 0, skipped: 0, renamed: 0, conflicts: [] };

  for (const file of files) {
    if (summary.conflicts.length >= 500) break;
    let path = file.path;
    if (validateFilePath(path)) {
      summary.skipped++;
      continue;
    }
    if (Buffer.byteLength(file.content, "utf8") > MAX_FILE_BYTES) {
      summary.skipped++;
      continue;
    }

    // folders are ensured up-front (and resurrected if a previous delete hid
    // them) so even skip/rename imports leave a coherent tree
    await ensureParentFolders(workspaceId, path, now);

    let existing = await db.document.findUnique({
      where: { workspaceId_path: { workspaceId, path } },
    });

    if (existing && !existing.deleted) {
      if (policy === "skip") {
        summary.skipped++;
        summary.conflicts.push(path);
        continue;
      }
      if (policy === "rename") {
        let n = 2;
        let candidate = withSuffix(path, n);
        while (taken.has(candidate)) candidate = withSuffix(path, ++n);
        path = candidate;
        summary.renamed++;
        existing = null; // import beside the existing file, never reuse its row
      } else {
        const res = await serviceClient.replaceDoc(workspaceId, existing.id, file.content, userId);
        if (!res.ok) {
          // Collab service unavailable: bump the revision so any stale client
          // resyncs instead of silently merging onto different content.
          await db.document.update({
            where: { id: existing.id },
            data: {
              content: file.content,
              docVersion: { increment: 1 },
              updatedAt: BigInt(now),
            },
          });
        }
        summary.overwritten++;
        continue;
      }
    }

    if (existing) {
      await db.document.update({
        where: { id: existing.id },
        data: { deleted: false, isFolder: false, content: file.content, updatedAt: BigInt(now) },
      });
    } else {
      await db.document.create({
        data: {
          workspaceId,
          path,
          isFolder: false,
          content: file.content,
          createdBy: userId,
          createdAt: BigInt(now),
          updatedAt: BigInt(now),
        },
      });
    }
    taken.add(path);
    summary.created++;
  }

  return summary;
}

export { MAX_FILE_BYTES };
