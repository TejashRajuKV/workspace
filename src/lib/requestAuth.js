// Framework-neutral request authentication helpers for the Express API.
import { getAuthUserByToken, getRole, SESSION_COOKIE } from "./authCore.js";
import { getCookieValue } from "./sessionCookie.js";

export async function authenticateRequest(req) {
  const header = typeof req?.headers?.get === "function"
    ? req.headers.get("cookie")
    : req?.headers?.cookie;
  const token = getCookieValue(header, SESSION_COOKIE);
  if (!token) return { ok: false, status: 401, error: "Not authenticated" };
  const auth = await getAuthUserByToken(token);
  if (!auth) return { ok: false, status: 401, error: "Not authenticated" };
  return { ok: true, user: auth.user, session: auth.session };
}

export async function authorizeWorkspaceRequest(req, workspaceId, { edit = false } = {}) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth;
  const role = await getRole(workspaceId, auth.user.id);
  if (!role) return { ok: false, status: 404, error: "Workspace not found or not a member" };
  if (edit && role === "viewer") {
    return { ok: false, status: 403, error: "Viewers cannot modify this workspace" };
  }
  return { ok: true, user: auth.user, session: auth.session, role };
}
