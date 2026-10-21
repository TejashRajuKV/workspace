// /api/workspaces/:id/files — the virtual file system of the code workspace.

import { db } from "../lib/db.js";
import { fail, json, readJson, readRaw } from "../lib/http.js";
import { requireMember, validateFilePath } from "../lib/apiHelpers.js";
import { serviceClient } from "../lib/serviceClient.js";
import { createZip, readZip } from "../lib/zip.js";
import { ensureParentFolders, importFiles } from "../lib/importer.js";
import { dispatchEvent } from "../lib/automation.js";
import TextOperation from "../../src/shared/ot.js";

export function registerFileRoutes(router) {
  router.get("/api/workspaces/:id/export.zip", async (req, res, { params, url }) => {
    const { id } = params;
    await requireMember(req, id);

    const ws = await db.workspace.findUnique({ where: { id } });
    if (!ws) throw fail("Workspace not found", 404);
    const folder = String(url.searchParams.get("path") || "");
    const where = { workspaceId: id, deleted: false, isFolder: false };
    if (folder) where.path = { startsWith: folder.endsWith("/") ? folder : folder + "/" };
    const docs = await db.document.findMany({ where, orderBy: { path: "asc" } });
    if (docs.length > 2000) throw fail("Too many files to export", 413);
    let total = 0;
    for (const doc of docs) {
      total += Buffer.byteLength(doc.content, "utf8");
      if (total > 50 * 1024 * 1024) throw fail("Workspace is too large to export", 413);
    }

    const entries = docs.map((doc) => ({
      name: doc.path,
      content: doc.content,
      mtime: new Date(Number(doc.updatedAt) || Date.now()),
    }));

    if (!folder) {
      const [state, objects] = await Promise.all([
        db.workspaceState.findUnique({ where: { workspaceId: id } }),
        db.canvasObject.findMany({ where: { workspaceId: id, deleted: false } }),
      ]);
      const canvas = objects.map((o) => ({
        id: o.id,
        type: o.type,
        payload: JSON.parse(o.payload || "{}"),
        z: o.zIndex,
      }));
      entries.push({
        name: ".iw/canvas.json",
        content: JSON.stringify({ format: "infinite-workspace.canvas", version: 1, boardVersion: state?.version || 0, objects: canvas }),
      });
      entries.push({
        name: ".iw/manifest.json",
        content: JSON.stringify({
          format: "infinite-workspace.bundle",
          version: 1,
          name: ws.name,
          exportedAt: new Date().toISOString(),
          files: docs.length,
          boardObjects: canvas.length,
        }),
      });
    }

    const archive = createZip(entries);
    const slug =
      String(ws.name || "workspace")
        .normalize("NFKD")
        .replace(/[^\w.-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "workspace";
    const utf8Name = encodeURIComponent(`${ws.name || "workspace"}.zip`).replace(/'/g, "%27");
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": archive.length,
      "content-disposition": `attachment; filename="${slug}.zip"; filename*=UTF-8''${utf8Name}`,
      "cache-control": "no-store",
    });
    res.end(archive);
  });

  // POST /api/workspaces/:id/import.zip  (raw application/zip body)
  // ?dryRun=1 → parse + report conflicts; ?policy=skip|overwrite|rename
  router.post("/api/workspaces/:id/import.zip", async (req, res, { params, url }) => {
    const { id } = params;
    const ctx = await requireMember(req, id, true);
    const dryRun = url.searchParams.get("dryRun") === "1";
    const policy = ["skip", "overwrite", "rename"].includes(url.searchParams.get("policy"))
      ? url.searchParams.get("policy")
      : "skip";
    const buf = await readRaw(req, 25 * 1024 * 1024);
    let parsed;
    try {
      parsed = readZip(buf, { maxFiles: 2000, maxFileBytes: 512 * 1024, maxTotalBytes: 25 * 1024 * 1024 });
    } catch (err) {
      throw fail(String(err.message || "Could not read ZIP archive"), 400);
    }

    const canvasEntry = parsed.files.find((f) => f.path === ".iw/canvas.json");
    let canvas = null;
    if (canvasEntry) {
      try {
        const doc = JSON.parse(canvasEntry.content);
        if (Array.isArray(doc?.objects)) canvas = { objects: doc.objects.slice(0, 5000) };
      } catch {}
    }
    const files = parsed.files.filter((f) => !f.path.startsWith(".iw/"));

    if (dryRun) {
      const existing = await db.document.findMany({
        where: { workspaceId: id, deleted: false, isFolder: false },
        select: { path: true },
      });
      const have = new Set(existing.map((d) => d.path));
      const conflicts = files.filter((f) => have.has(f.path)).map((f) => f.path);
      return json(res, {
        dryRun: true,
        files: files.map((f) => ({ path: f.path, size: f.size })),
        conflicts,
        skipped: parsed.skipped,
        canvasObjects: canvas ? canvas.objects.length : 0,
      });
    }

    const summary = await importFiles(id, files, { policy, userId: ctx.user.id });
    if (summary.created || summary.overwritten || summary.renamed) {
      serviceClient.notifyFsChanged(id, "imported").catch(() => {});
    }
    return json(res, {
      ok: true,
      policy,
      summary,
      skippedEntries: parsed.skipped.slice(0, 100),
      canvas,
    });
  });

  // POST /api/workspaces/:id/files { path, isFolder?, content? }
  router.post("/api/workspaces/:id/files", async (req, res, { params }) => {
    const { id } = params;
    const ctx = await requireMember(req, id, true);

    const body = await readJson(req);
    const pathErr = validateFilePath(body.path);
    if (pathErr) throw fail(pathErr);
    const path = body.path;
    const isFolder = !!body.isFolder;
    const content = isFolder ? "" : String(body.content ?? "");

    if (!isFolder && content.length > 512 * 1024)
      throw fail("File too large (max 512KB)");

    const existing = await db.document.findUnique({
      where: { workspaceId_path: { workspaceId: id, path } },
    });
    if (existing && !existing.deleted) throw fail("A file with this path already exists", 409);

    const now = Date.now();
    const doc = existing
      ? await db.document.update({
          where: { id: existing.id },
          data: {
            deleted: false,
            isFolder,
            content,
            updatedAt: BigInt(now),
            createdBy: ctx.user.id,
          },
        })
      : await db.document.create({
          data: {
            workspaceId: id,
            path,
            isFolder,
            content,
            createdBy: ctx.user.id,
            createdAt: BigInt(now),
            updatedAt: BigInt(now),
          },
        });

    // ensure parent folders exist
    await ensureParentFolders(id, path, now);
    if (!isFolder) {
      await db.documentSnapshot.upsert({
        where: { documentId_version: { documentId: doc.id, version: 0 } },
        update: {},
        create: {
          documentId: doc.id,
          workspaceId: id,
          version: 0,
          content,
          createdAt: BigInt(now),
        },
      });
    }

    serviceClient.notifyFsChanged(id, "created").catch(() => {});
    dispatchEvent({
      workspaceId: id,
      event: "file.created",
      actorId: ctx.user.id,
      payload: { path: doc.path, isFolder: doc.isFolder, id: doc.id },
    }).catch(() => {});
    return json(res, { doc: { id: doc.id, path: doc.path, isFolder: doc.isFolder } }, 201);
  });

  // PATCH /api/workspaces/:id/files/:fileId { path } → rename / move
  router.patch("/api/workspaces/:id/files/:fileId", async (req, res, { params }) => {
    const { id, fileId } = params;
    await requireMember(req, id, true);

    const body = await readJson(req);
    const pathErr = validateFilePath(body.path);
    if (pathErr) throw fail(pathErr);
    const newPath = body.path;

    const doc = await db.document.findFirst({
      where: { id: fileId, workspaceId: id, deleted: false },
    });
    if (!doc) throw fail("File not found", 404);

    const clash = await db.document.findUnique({
      where: { workspaceId_path: { workspaceId: id, path: newPath } },
    });
    if (clash && !clash.deleted && clash.id !== doc.id)
      throw fail("Target path already exists", 409);

    const now = Date.now();
    if (doc.isFolder) {
      // rename all descendants
      const children = await db.document.findMany({
        where: { workspaceId: id, path: { startsWith: doc.path } },
      });
      for (const child of children) {
        const renamed = newPath + child.path.slice(doc.path.length);
        await db.document.update({
          where: { id: child.id },
          data: { path: renamed, updatedAt: BigInt(now) },
        });
      }
    }
    await db.document.update({
      where: { id: doc.id },
      data: { path: newPath, updatedAt: BigInt(now) },
    });

    // ensure parent folders of the new path exist (same as POST) — without this
    // a rename into "lib/helpers.py" leaves an orphan row with no "lib/" folder,
    // which the tree builder then can't place
    await ensureParentFolders(id, newPath, now);

    serviceClient.notifyFsChanged(id, "renamed").catch(() => {});
    dispatchEvent({
      workspaceId: id,
      event: "file.updated",
      actorId: ctx.user.id,
      payload: { id: doc.id, path: newPath, renamed: true },
    }).catch(() => {});
    return json(res, { ok: true });
  });

  // DELETE /api/workspaces/:id/files/:fileId → soft delete (+ descendants)
  router.delete("/api/workspaces/:id/files/:fileId", async (req, res, { params }) => {
    const { id, fileId } = params;
    await requireMember(req, id, true);

    const doc = await db.document.findFirst({
      where: { id: fileId, workspaceId: id, deleted: false },
    });
    if (!doc) throw fail("File not found", 404);

    const now = Date.now();
    if (doc.isFolder) {
      await db.document.updateMany({
        where: { workspaceId: id, path: { startsWith: doc.path } },
        data: { deleted: true, deletedAt: BigInt(now), updatedAt: BigInt(now) },
      });
    }
    await db.document.update({
      where: { id: doc.id },
      data: { deleted: true, deletedAt: BigInt(now), updatedAt: BigInt(now) },
    });

    serviceClient.notifyFsChanged(id, "deleted").catch(() => {});
    dispatchEvent({
      workspaceId: id,
      event: "file.deleted",
      actorId: ctx.user.id,
      payload: { id: doc.id, path: doc.path, isFolder: doc.isFolder },
    }).catch(() => {});
    return json(res, { ok: true });
  });

  // GET /api/workspaces/:id/files/:fileId/versions → revision list
  router.get("/api/workspaces/:id/files/:fileId/versions", async (req, res, { params }) => {
    const { id, fileId } = params;
    await requireMember(req, id);
    const doc = await db.document.findFirst({ where: { id: fileId, workspaceId: id, deleted: false, isFolder: false } });
    if (!doc) throw fail("File not found", 404);

    const baseline = await ensureBaseline(doc);
    const ops = await db.documentOperation.findMany({
      where: { documentId: fileId, version: { gt: baseline.version } },
      orderBy: { version: "asc" },
      take: 1000,
    });
    const users = await db.user.findMany({
      where: { id: { in: [...new Set(ops.map((o) => o.userId))] } },
      select: { id: true, username: true },
    });
    const names = new Map(users.map((u) => [u.id, u.username]));
    return json(res, {
      currentVersion: doc.docVersion,
      baseline: { version: baseline.version, createdAt: Number(baseline.createdAt) },
      versions: ops.map((o) => ({
        version: o.version,
        by: names.get(o.userId) || o.userId,
        at: Number(o.createdAt),
      })),
      complete: baseline.version + ops.length === doc.docVersion,
    });
  });

  // GET /api/workspaces/:id/files/:fileId/versions/:version → reconstructed content
  router.get("/api/workspaces/:id/files/:fileId/versions/:version", async (req, res, { params }) => {
    const { id, fileId } = params;
    await requireMember(req, id);
    const target = Number(params.version);
    if (!Number.isInteger(target) || target < 0) throw fail("Invalid version");
    const doc = await db.document.findFirst({ where: { id: fileId, workspaceId: id, deleted: false, isFolder: false } });
    if (!doc) throw fail("File not found", 404);
    if (target > doc.docVersion) throw fail("Version does not exist", 404);

    const result = await reconstruct(doc, target);
    if (!result.ok) throw fail(result.error, 409);
    return json(res, { version: target, content: result.content, complete: result.complete });
  });

  // POST /api/workspaces/:id/files/:fileId/restore { version }
  router.post("/api/workspaces/:id/files/:fileId/restore", async (req, res, { params }) => {
    const { id, fileId } = params;
    const ctx = await requireMember(req, id, true);
    const body = await readJson(req);
    const target = Number(body.version);
    if (!Number.isInteger(target) || target < 0) throw fail("Invalid version");
    const doc = await db.document.findFirst({ where: { id: fileId, workspaceId: id, deleted: false, isFolder: false } });
    if (!doc) throw fail("File not found", 404);
    if (target > doc.docVersion) throw fail("Version does not exist", 404);

    const result = await reconstruct(doc, target);
    if (!result.ok) throw fail(result.error, 409);

    const applied = await serviceClient.replaceDoc(id, fileId, result.content, ctx.user.id);
    if (!applied.ok) {
      await db.document.update({
        where: { id: fileId },
        data: { content: result.content, docVersion: { increment: 1 }, updatedAt: BigInt(Date.now()) },
      });
      serviceClient.notifyFsChanged(id, "restored").catch(() => {});
    }
    dispatchEvent({
      workspaceId: id,
      event: "file.updated",
      actorId: ctx.user.id,
      payload: { id: fileId, restored: target },
    }).catch(() => {});
    return json(res, { ok: true, version: target, rev: applied.data?.rev });
  });

  // POST /api/workspaces/:id/replace { query, replacement, caseSensitive?, dryRun? }
  // Global find & replace across files. Applied through the collaboration OT
  // pipeline so any open editor stays in sync.
  router.post("/api/workspaces/:id/replace", async (req, res, { params }) => {
    const { id } = params;
    const ctx = await requireMember(req, id, true);
    const body = await readJson(req);

    const query = String(body.query ?? "");
    if (!query) throw fail("query is required");
    if (query.length > 200) throw fail("query is too long");
    const replacement = String(body.replacement ?? "");
    if (replacement.length > 400) throw fail("replacement is too long");
    const caseSensitive = body.caseSensitive !== false;
    const dryRun = body.dryRun === true;
    const paths = Array.isArray(body.paths) ? body.paths.map(String).slice(0, 2000) : null;

    const docs = await db.document.findMany({
      where: { workspaceId: id, deleted: false, isFolder: false },
      orderBy: { path: "asc" },
      take: 2000,
    });

    const flags = caseSensitive ? "g" : "gi";
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, flags);

    const results = [];
    let changed = 0;
    for (const doc of docs) {
      if (paths && !paths.includes(doc.path)) continue;
      const matches = (doc.content.match(re) || []).length;
      if (!matches) continue;
      changed += 1;
      const next = doc.content.replace(re, replacement);
      results.push({ path: doc.path, id: doc.id, matches });
      if (!dryRun) {
        const applied = await serviceClient.replaceDoc(id, doc.id, next, ctx.user.id);
        if (!applied.ok) {
          await db.document.update({
            where: { id: doc.id },
            data: { content: next, docVersion: { increment: 1 }, updatedAt: BigInt(Date.now()) },
          });
        }
      }
    }

    if (!dryRun && changed) {
      serviceClient.notifyFsChanged(id, "replaced").catch(() => {});
      dispatchEvent({
        workspaceId: id,
        event: "file.updated",
        actorId: ctx.user.id,
        payload: { replace: true, files: changed, query },
      }).catch(() => {});
    }
    return json(res, { dryRun, files: changed, results: results.slice(0, 500) });
  });
}

// Lazily create the history baseline for documents that predate the feature:
// ops are only replayable from the point the baseline was captured.
async function ensureBaseline(doc) {
  const found = await db.documentSnapshot.findFirst({
    where: { documentId: doc.id },
    orderBy: { version: "desc" },
  });
  if (found) return found;
  return db.documentSnapshot.create({
    data: {
      documentId: doc.id,
      workspaceId: doc.workspaceId,
      version: doc.docVersion,
      content: doc.content,
      createdAt: BigInt(Date.now()),
    },
  });
}

async function reconstruct(doc, target) {
  const baseline = await ensureBaseline(doc);
  if (target < baseline.version) {
    return { ok: false, error: "This version predates history capture for this file" };
  }
  if (target === baseline.version) return { ok: true, content: baseline.content, complete: true };

  const ops = await db.documentOperation.findMany({
    where: { documentId: doc.id, version: { gt: baseline.version, lte: target } },
    orderBy: { version: "asc" },
  });
  if (ops.length !== target - baseline.version) {
    return { ok: false, error: "History for this version is no longer complete" };
  }
  let content = baseline.content;
  for (const row of ops) {
    try {
      content = TextOperation.fromJSON(JSON.parse(row.op)).apply(content);
    } catch {
      return { ok: false, error: "Could not replay history for this version" };
    }
  }
  return { ok: true, content, complete: true };
}
