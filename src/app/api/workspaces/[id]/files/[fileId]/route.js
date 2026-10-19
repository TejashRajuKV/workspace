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

  // A folder cannot be moved into itself or any of its descendants. Doing so
  // rewrites descendant paths while iterating them and can corrupt the virtual
  // filesystem tree (for example, moving "src/" to "src/lib/").
  if (doc.isFolder && newPath.startsWith(doc.path)) {
    return fail("A folder cannot be moved inside itself", 400);
  }

  const clash = await db.document.findUnique({
    where: { workspaceId_path: { workspaceId: id, path: newPath } },
  });
  if (clash && clash.id !== doc.id) {
    // The workspace/path pair is unique even for soft-deleted rows. Allowing
    // a rename onto a deleted path would pass validation and then fail with a
    // database uniqueness error when updating the current document.
    return fail(
      clash.deleted ? "Target path belongs to a deleted item; recreate it or choose another path" : "Target path already exists",
      409
    );
  }

  const now = Date.now();
  if (doc.isFolder) {
    // rename all descendants
    const children = await db.document.findMany({
      where: { workspaceId: id, path: { startsWith: doc.path } },
    });

    // Preflight every destination before changing any row. Checking only the
    // folder's new path misses conflicts such as moving src/ to lib/ when
    // lib/index.js already exists; the first descendant update would otherwise
    // hit the unique (workspaceId, path) constraint after earlier rows moved.
    const movingIds = new Set(children.map((child) => child.id));
    const targetPaths = new Set(
      children.map((child) => newPath + child.path.slice(doc.path.length))
    );
    const destinationRows = await db.document.findMany({
      where: { workspaceId: id, path: { startsWith: newPath } },
      select: { id: true, path: true },
    });
    const conflict = destinationRows.find(
      (row) => targetPaths.has(row.path) && !movingIds.has(row.id)
    );
    if (conflict) {
      return fail("A file or folder already exists at the destination path", 409);
    }

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
  const parts = newPath.split("/");
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
    } else if (parent.deleted) {
      // Reusing a path beneath a previously deleted folder must restore the
      // parent too; otherwise the child exists in the DB but is invisible in
      // bootstrap's deleted=false tree.
      await db.document.update({
        where: { id: parent.id },
        data: { deleted: false, isFolder: true, content: "", updatedAt: BigInt(now) },
      });
    }
  }

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
