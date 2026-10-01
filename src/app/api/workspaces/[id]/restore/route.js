import { NextResponse } from "next/server";
import { fail, requireMember, isResponse } from "@/lib/apiHelpers";
import { serviceClient } from "@/lib/serviceClient";

// POST /api/workspaces/:id/restore { version }
// Delegates to the collaboration service, which:
//   1. computes the workspace state at `version` (latest snapshot ≤ version
//      + replay of subsequent operations)
//   2. diffs it against the current state
//   3. emits the difference as new (regular, broadcast) operations
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
  const version = parseInt(body.version, 10);
  if (!isFinite(version) || version < 0) return fail("Invalid version");

  const result = await serviceClient.restore(id, version, ctx.user.id, ctx.user.username);
  if (!result.ok) {
    return fail(result.data?.error || "Restore failed (is the collaboration service running?)", 502);
  }
  return NextResponse.json(result.data);
}
