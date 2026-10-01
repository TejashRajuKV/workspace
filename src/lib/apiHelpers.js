import { NextResponse } from "next/server";
import { getAuthUser, getRole } from "./auth";
import { db } from "./db";
import { validateFilePath } from "@/shared/protocol";

export { validateFilePath };

// Standard JSON error response
export function fail(message, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

// Authenticate the request via session cookie; attach { user } or return null.
export async function requireAuth() {
  const auth = await getAuthUser();
  if (!auth) return null;
  return auth.user;
}

// Authenticate + verify membership in a workspace.
// Returns { user, role } or a NextResponse error (check instanceof Response).
export async function requireMember(workspaceId, needEdit = false) {
  const auth = await getAuthUser();
  if (!auth) return { error: fail("Not authenticated", 401) };
  const role = await getRole(workspaceId, auth.user.id);
  if (!role) return { error: fail("Workspace not found or not a member", 404) };
  if (needEdit && role === "viewer")
    return { error: fail("Viewers cannot modify this workspace", 403) };
  return { user: auth.user, role };
}

export function isResponse(x) {
  return x && typeof x === "object" && x instanceof Response;
}

export async function memberCount(workspaceId) {
  return db.workspaceMember.count({ where: { workspaceId } });
}
