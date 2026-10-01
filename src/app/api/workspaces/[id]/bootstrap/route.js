import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publicUser } from "@/lib/auth";
import { fail, requireMember, isResponse } from "@/lib/apiHelpers";

// GET /api/workspaces/:id/bootstrap
// Everything a client needs to open a workspace in one round trip:
// meta, role, members, and the full document tree (with contents).
// Canvas objects + canvas version arrive via the socket `ws:join` ack.
export async function GET(req, { params }) {
  const { id } = await params;
  const ctx = await requireMember(id);
  if (isResponse(ctx)) return ctx;

  const ws = await db.workspace.findUnique({ where: { id } });
  if (!ws) return fail("Workspace not found", 404);

  const members = await db.workspaceMember.findMany({
    where: { workspaceId: id },
  });
  const users = await db.user.findMany({
    where: { id: { in: members.map((m) => m.userId) } },
  });
  const userMap = Object.fromEntries(users.map((u) => [u.id, publicUser(u)]));

  const docs = await db.document.findMany({
    where: { workspaceId: id, deleted: false },
    orderBy: { path: "asc" },
  });

  return NextResponse.json({
    workspace: {
      id: ws.id,
      name: ws.name,
      description: ws.description,
      ownerId: ws.ownerId,
    },
    role: members.find((m) => m.userId === ctx.user.id)?.role || "viewer",
    me: publicUser(ctx.user),
    members: members.map((m) => ({
      user: userMap[m.userId] || { id: m.userId, username: "unknown", color: "#888" },
      role: m.role,
    })),
    docs: docs.map((d) => ({
      id: d.id,
      path: d.path,
      isFolder: d.isFolder,
      content: d.isFolder ? "" : d.content,
      docVersion: d.docVersion,
      createdBy: d.createdBy,
      updatedAt: Number(d.updatedAt),
    })),
  });
}
