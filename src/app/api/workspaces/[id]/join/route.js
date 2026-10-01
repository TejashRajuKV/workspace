import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail, requireAuth } from "@/lib/apiHelpers";

// POST /api/workspaces/:id/join
// Join a workspace by ID (share-by-id model). First join becomes an editor;
// re-joining is idempotent. Owners keep their role.
export async function POST(req, { params }) {
  const { id } = await params;
  const user = await requireAuth();
  if (!user) return fail("Not authenticated", 401);

  const ws = await db.workspace.findUnique({ where: { id } });
  if (!ws) return fail("Workspace not found", 404);

  const existing = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: id, userId: user.id } },
  });
  if (existing) return NextResponse.json({ ok: true, role: existing.role });

  const member = await db.workspaceMember.create({
    data: {
      workspaceId: id,
      userId: user.id,
      role: "editor",
      joinedAt: BigInt(Date.now()),
    },
  });
  return NextResponse.json({ ok: true, role: member.role }, { status: 201 });
}
