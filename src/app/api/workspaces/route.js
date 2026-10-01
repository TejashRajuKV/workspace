import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAuthUser, publicUser } from "@/lib/auth";
import { fail } from "@/lib/apiHelpers";

// GET /api/workspaces → workspaces I am a member of
export async function GET() {
  const auth = await getAuthUser();
  if (!auth) return fail("Not authenticated", 401);

  const memberships = await db.workspaceMember.findMany({
    where: { userId: auth.user.id },
  });
  const ids = memberships.map((m) => m.workspaceId);
  const workspaces = await db.workspace.findMany({
    where: { id: { in: ids } },
    orderBy: { updatedAt: "desc" },
  });
  const owners = await db.user.findMany({
    where: { id: { in: workspaces.map((w) => w.ownerId) } },
  });
  const ownerMap = Object.fromEntries(owners.map((o) => [o.id, publicUser(o)]));
  const roleMap = Object.fromEntries(
    memberships.map((m) => [m.workspaceId, m.role])
  );

  return NextResponse.json({
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      ownerId: w.ownerId,
      owner: ownerMap[w.ownerId] || null,
      role: roleMap[w.id] || "viewer",
      createdAt: Number(w.createdAt),
      updatedAt: Number(w.updatedAt),
    })),
  });
}

// POST /api/workspaces { name, description? } → create (creator becomes owner)
export async function POST(req) {
  const auth = await getAuthUser();
  if (!auth) return fail("Not authenticated", 401);
  let body;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON");
  }
  const name = String(body.name || "").trim();
  if (!name || name.length > 120) return fail("Name must be 1-120 characters");
  const description = String(body.description || "").slice(0, 500);
  const now = Date.now();

  const ws = await db.workspace.create({
    data: {
      name,
      description,
      ownerId: auth.user.id,
      createdAt: BigInt(now),
      updatedAt: BigInt(now),
    },
  });
  await db.workspaceMember.create({
    data: {
      workspaceId: ws.id,
      userId: auth.user.id,
      role: "owner",
      joinedAt: BigInt(now),
    },
  });
  return NextResponse.json({
    workspace: {
      id: ws.id,
      name: ws.name,
      description: ws.description,
      ownerId: ws.ownerId,
      role: "owner",
      createdAt: Number(ws.createdAt),
      updatedAt: Number(ws.updatedAt),
    },
  }, { status: 201 });
}
