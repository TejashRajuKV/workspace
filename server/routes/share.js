// Public, unauthenticated read-only share links.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../lib/db.js";
import { fail, json, readJson } from "../lib/http.js";
import { requireMember } from "../lib/apiHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function registerShareRoutes(router) {
  // POST /api/workspaces/:id/share-links { expiresInHours? }
  router.post("/api/workspaces/:id/share-links", async (req, res, { params }) => {
    const { id } = params;
    const { user, role } = await requireMember(req, id);
    if (role !== "owner") throw fail("Only the owner can create share links", 403);
    const body = await readJson(req);
    const hours = Number(body.expiresInHours) || 0;
    const token = crypto.randomBytes(18).toString("base64url");
    const link = await db.shareLink.create({
      data: {
        workspaceId: id,
        tokenHash: hashToken(token),
        role: "viewer",
        createdBy: user.id,
        expiresAt: hours > 0 ? BigInt(Date.now() + hours * 3600_000) : BigInt(0),
        createdAt: BigInt(Date.now()),
      },
    });
    return json(res, { share: { ...shape(link), url: `/?s=${token}` } }, 201);
  });

  // GET /api/workspaces/:id/share-links
  router.get("/api/workspaces/:id/share-links", async (req, res, { params }) => {
    const { id } = params;
    const { role } = await requireMember(req, id);
    if (role !== "owner") throw fail("Only the owner can view share links", 403);
    const rows = await db.shareLink.findMany({
      where: { workspaceId: id },
      orderBy: { createdAt: "desc" },
    });
    return json(res, { shares: rows.map(shape) });
  });

  // DELETE /api/workspaces/:id/share-links/:linkId
  router.delete("/api/workspaces/:id/share-links/:linkId", async (req, res, { params }) => {
    const { id, linkId } = params;
    const { role } = await requireMember(req, id);
    if (role !== "owner") throw fail("Only the owner can revoke share links", 403);
    await db.shareLink.updateMany({ where: { id: linkId, workspaceId: id }, data: { revoked: true } });
    return json(res, { ok: true });
  });

  // GET /api/share/:token  — PUBLIC read-only snapshot (no auth).
  router.get("/api/share/:token", async (req, res, { params }) => {
    const token = String(params.token || "");
    if (token.length < 16) throw fail("Invalid share link", 404);
    const link = await db.shareLink.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!link || link.revoked) throw fail("Share link not found", 404);
    if (Number(link.expiresAt) > 0 && Number(link.expiresAt) < Date.now()) {
      throw fail("Share link expired", 410);
    }
    const ws = await db.workspace.findUnique({ where: { id: link.workspaceId } });
    if (!ws) throw fail("Workspace not found", 404);

    const docs = await db.document.findMany({
      where: { workspaceId: ws.id, deleted: false },
      orderBy: { path: "asc" },
      take: MAX_FILES,
    });
    let total = 0;
    const files = [];
    const folders = [];
    for (const d of docs) {
      if (d.isFolder) {
        folders.push(d.path);
        continue;
      }
      total += Buffer.byteLength(d.content);
      if (total > MAX_TOTAL_BYTES) break;
      files.push({ path: d.path, content: d.content });
    }
    const objects = await db.canvasObject.findMany({
      where: { workspaceId: ws.id, deleted: false },
      orderBy: { zIndex: "asc" },
    });
    const canvas = objects.map((o) => {
      let payload = {};
      try {
        payload = JSON.parse(o.payload);
      } catch {
        payload = {};
      }
      return { id: o.id, type: o.type, z: o.zIndex, payload };
    });
    const assets = await db.asset.findMany({ where: { workspaceId: ws.id } });
    const assetMap = Object.fromEntries(assets.map((a) => [a.id, assetRef(a)]));

    return json(res, {
      workspace: { id: ws.id, name: ws.name, description: ws.description },
      files,
      folders,
      canvas,
      assets: assetMap,
      readOnly: true,
    });
  });

  // GET /api/share/:token/assets/:assetId — PUBLIC asset stream for shared boards.
  router.get("/api/share/:token/assets/:assetId", async (req, res, { params }) => {
    const link = await db.shareLink.findUnique({ where: { tokenHash: hashToken(params.token) } });
    if (!link || link.revoked) throw fail("Share link not found", 404);
    if (Number(link.expiresAt) > 0 && Number(link.expiresAt) < Date.now()) {
      throw fail("Share link expired", 410);
    }
    const asset = await db.asset.findFirst({ where: { id: params.assetId, workspaceId: link.workspaceId } });
    if (!asset) throw fail("Asset not found", 404);
    const full = path.resolve(UPLOAD_DIR, asset.path);
    if (!full.startsWith(UPLOAD_DIR + path.sep)) throw fail("Asset not found", 404);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      throw fail("Asset file missing", 404);
    }
    res.writeHead(200, {
      "content-type": asset.mime,
      "content-length": stat.size,
      "cache-control": "public, max-age=86400",
    });
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(full);
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.pipe(res);
    });
    return undefined;
  });
}

function assetRef(a) {
  return { id: a.id, filename: a.filename, mime: a.mime, bytes: a.bytes };
}

function shape(row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    role: row.role,
    revoked: row.revoked,
    expiresAt: Number(row.expiresAt),
    createdAt: Number(row.createdAt),
  };
}
