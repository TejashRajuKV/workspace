import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail, requireMember, isResponse, validateFilePath } from "@/lib/apiHelpers";
import { serviceClient } from "@/lib/serviceClient";

// POST /api/workspaces/:id/files { path, isFolder?, content? }
export async function POST(req, { params }) {
  const { id } = await params;
  const ctx = await requireMember(id, true);
  if (isResponse(ctx)) return ctx;

  let body;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON");
  }
  const pathErr = validateFilePath(body.path);
  if (pathErr) return fail(pathErr);
  const path = body.path;
  const isFolder = !!body.isFolder;
  const content = isFolder ? "" : String(body.content ?? "");

  if (!isFolder && content.length > 512 * 1024)
    return fail("File too large (max 512KB)");

  const existing = await db.document.findUnique({
    where: { workspaceId_path: { workspaceId: id, path } },
  });
  if (existing && !existing.deleted) return fail("A file with this path already exists", 409);

  const now = Date.now();
  const doc = existing
    ? await db.document.update({
        where: { id: existing.id },
        data: { deleted: false, isFolder, content, updatedAt: BigInt(now), createdBy: ctx.user.id },
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
  const parts = path.split("/");
  parts.pop();
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const parent = await db.document.findUnique({
      where: { workspaceId_path: { workspaceId: id, path: prefix + "/" } },
    });
    if (!parent) {
      await db.document.create({
        data: {
          workspaceId: id,
          path: prefix + "/",
          isFolder: true,
          createdAt: BigInt(now),
          updatedAt: BigInt(now),
        },
      });
    }
  }

  serviceClient.notifyFsChanged(id, "created").catch(() => {});
  return NextResponse.json({ doc: { id: doc.id, path: doc.path, isFolder: doc.isFolder } }, { status: 201 });
}
