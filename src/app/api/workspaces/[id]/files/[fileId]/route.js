import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail, requireMember, isResponse, validateFilePath } from "@/lib/apiHelpers";
import { serviceClient } from "@/lib/serviceClient";

// PATCH /api/workspaces/:id/files/:fileId { path } → rename / move
export async function PATCH(req, { params }) {
  const { id, fileId } = await params;
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
  const newPath = body.path;

  const doc = await db.document.findFirst({
    where: { id: fileId, workspaceId: id, deleted: false },
  });
  if (!doc) return fail("File not found", 404);

  const clash = await db.document.findUnique({
    where: { workspaceId_path: { workspaceId: id, path: newPath } },
  });
  if (clash && !clash.deleted && clash.id !== doc.id)
    return fail("Target path already exists", 409);

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

  serviceClient.notifyFsChanged(id, "renamed").catch(() => {});
  return NextResponse.json({ ok: true });
}

// DELETE /api/workspaces/:id/files/:fileId → soft delete (+ descendants)
export async function DELETE(req, { params }) {
  const { id, fileId } = await params;
  const ctx = await requireMember(id, true);
  if (isResponse(ctx)) return ctx;

  const doc = await db.document.findFirst({
    where: { id: fileId, workspaceId: id, deleted: false },
  });
  if (!doc) return fail("File not found", 404);

  const now = Date.now();
  if (doc.isFolder) {
    await db.document.updateMany({
      where: { workspaceId: id, path: { startsWith: doc.path } },
      data: { deleted: true, updatedAt: BigInt(now) },
    });
  }
  await db.document.update({ where: { id: doc.id }, data: { deleted: true, updatedAt: BigInt(now) } });

  serviceClient.notifyFsChanged(id, "deleted").catch(() => {});
  return NextResponse.json({ ok: true });
}
