// /api/workspaces/:id/assets — binary board-image storage on disk.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { db } from "../lib/db.js";
import { fail, json, readRaw } from "../lib/http.js";
import { requireMember } from "../lib/apiHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const MAX_BYTES = 8 * 1024 * 1024;

const EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

function safeExt(mime, filename) {
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const ext = path.extname(String(filename || "")).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ".bin";
}

export function registerAssetRoutes(router) {
  // POST /api/workspaces/:id/assets  (raw image body; content-type = mime)
  router.post("/api/workspaces/:id/assets", async (req, res, { params }) => {
    const { id } = params;
    const { user } = await requireMember(req, id, true);
    const mime = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();
    if (!mime.startsWith("image/")) throw fail("Only image uploads are allowed", 415);
    const buffer = await readRaw(req, MAX_BYTES);
    if (!buffer.length) throw fail("Empty upload");
    if (buffer.length > MAX_BYTES) throw fail("Image too large (max 8 MB)", 413);

    const assetId = crypto.randomUUID();
    const ext = safeExt(mime, req.headers["x-filename"]);
    const dir = path.join(UPLOAD_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.join(id, `${assetId}${ext}`);
    fs.writeFileSync(path.join(UPLOAD_DIR, rel), buffer);

    const asset = await db.asset.create({
      data: {
        id: assetId,
        workspaceId: id,
        filename: String(req.headers["x-filename"] || `image${ext}`).slice(0, 160),
        mime,
        bytes: buffer.length,
        path: rel,
        createdBy: user.id,
        createdAt: BigInt(Date.now()),
      },
    });
    return json(res, { asset: shape(asset) }, 201);
  });

  // GET /api/workspaces/:id/assets  (member-only list for the image picker)
  router.get("/api/workspaces/:id/assets", async (req, res, { params }) => {
    const { id } = params;
    await requireMember(req, id);
    const rows = await db.asset.findMany({
      where: { workspaceId: id },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return json(res, { assets: rows.map(shape) });
  });

  // GET /api/workspaces/:id/assets/:assetId  (member-only binary stream)
  router.get("/api/workspaces/:id/assets/:assetId", async (req, res, { params }) => {
    const { id, assetId } = params;
    await requireMember(req, id);
    const asset = await db.asset.findFirst({ where: { id: assetId, workspaceId: id } });
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
      "cache-control": "private, max-age=86400",
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

function shape(row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    url: `/api/workspaces/${row.workspaceId}/assets/${row.id}`,
    createdAt: Number(row.createdAt),
  };
}
