import { fail } from "./http.js";
import { getAuthUser, getRole } from "./auth.js";
import { db } from "./db.js";
import { validateFilePath } from "../../src/shared/protocol.js";

export { validateFilePath };

// Authenticate the request via session cookie; throws 401 when there is none.
export async function requireAuth(req) {
  const auth = await getAuthUser(req);
  if (!auth) throw fail("Not authenticated", 401);
  return auth.user;
}

// Authenticate + verify membership in a workspace. Throws 401/404/403 instead of
// returning a response, so handlers read top-to-bottom.
export async function requireMember(req, workspaceId, needEdit = false) {
  const auth = await getAuthUser(req);
  if (!auth) throw fail("Not authenticated", 401);
  const role = await getRole(workspaceId, auth.user.id);
  if (!role) throw fail("Workspace not found or not a member", 404);
  if (needEdit && role === "viewer")
    throw fail("Viewers cannot modify this workspace", 403);
  return { user: auth.user, role };
}

export async function memberCount(workspaceId) {
  return db.workspaceMember.count({ where: { workspaceId } });
}