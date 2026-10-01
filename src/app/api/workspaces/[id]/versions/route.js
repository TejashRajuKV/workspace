import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publicUser } from "@/lib/auth";
import { fail, requireMember, isResponse } from "@/lib/apiHelpers";

// GET /api/workspaces/:id/versions?limit=200&before=<version>
// Recent operation history (newest first) with user attribution.
export async function GET(req, { params }) {
  const { id } = await params;
  const ctx = await requireMember(id);
  if (isResponse(ctx)) return ctx;

  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1), 500);
  const before = parseInt(url.searchParams.get("before") || "", 10);

  const where = { workspaceId: id };
  if (isFinite(before) && before > 0) where.version = { lt: before };

  const ops = await db.operation.findMany({
    where,
    orderBy: { version: "desc" },
    take: limit,
  });

  const users = await db.user.findMany({
    where: { id: { in: [...new Set(ops.map((o) => o.userId))] } },
  });
  const userMap = Object.fromEntries(users.map((u) => [u.id, publicUser(u)]));

  return NextResponse.json({
    operations: ops.map((o) => ({
      version: o.version,
      type: o.type,
      objectId: o.objectId,
      payload: JSON.parse(o.payload || "{}"),
      user: userMap[o.userId] || { id: o.userId, username: "unknown", color: "#888" },
      createdAt: Number(o.createdAt),
    })),
    hasMore: ops.length === limit,
  });
}
