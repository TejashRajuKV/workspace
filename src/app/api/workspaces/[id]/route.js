import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publicUser } from "@/lib/auth";
import { fail, requireMember, isResponse } from "@/lib/apiHelpers";

// GET /api/workspaces/:id → meta + members + my role
export async function GET(req, { params }) {
  const { id } = await params;
  const ctx = await requireMember(id);
  if (isResponse(ctx)) return ctx;
  const { user } = ctx;

  const ws = await db.workspace.findUnique({ where: { id } });
  if (!ws) return fail("Workspace not found", 404);
  const members = await db.workspaceMember.findMany({
    where: { workspaceId: id },
  });
  const users = await db.user.findMany({
    where: { id: { in: members.map((m) => m.userId) } },
  });
  const userMap = Object.fromEntries(users.map((u) => [u.id, publicUser(u)]));

  return NextResponse.json({
    workspace: {
      id: ws.id,
      name: ws.name,
      description: ws.description,
      ownerId: ws.ownerId,
      createdAt: Number(ws.createdAt),
      updatedAt: Number(ws.updatedAt),
    },
    role: members.find((m) => m.userId === user.id)?.role || "viewer",
    members: members.map((m) => ({
      user: userMap[m.userId] || { id: m.userId, username: "unknown", color: "#888" },
      role: m.role,
      joinedAt: Number(m.joinedAt),
    })),
  });
}

// DELETE /api/workspaces/:id → owner only
export async function DELETE(req, { params }) {
  const { id } = await params;
  const ctx = await requireMember(id);
  if (isResponse(ctx)) return ctx;
  if (ctx.role !== "owner") return fail("Only the owner can delete a workspace", 403);

  await db.workspaceMember.deleteMany({ where: { workspaceId: id } });
  await db.document.deleteMany({ where: { workspaceId: id } });
  await db.workspace.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

// PATCH /api/workspaces/:id { name?, description? } → owner/editor
export async function PATCH(req, { params }) {
  const { id } = await params;
  const ctx = await requireMember(id, true);
  if (isResponse(ctx)) return ctx;
  let body;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON");
  }
  const data = {};
  if (typeof body.name === "string" && body.name.trim())
    data.name = body.name.trim().slice(0, 120);
  if (typeof body.description === "string")
    data.description = body.description.slice(0, 500);
  if (!Object.keys(data).length) return fail("Nothing to update");
  data.updatedAt = Date.now();
  const ws = await db.workspace.update({ where: { id }, data });
  return NextResponse.json({ workspace: ws });
}
