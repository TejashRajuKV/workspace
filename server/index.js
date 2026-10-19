import { createServer } from "node:http";
import { db } from "../src/lib/db.js";
import {
  createSession,
  getAuthUserByToken,
  hashPassword,
  pickColor,
  publicUser,
  SESSION_COOKIE,
  sessionCookieOptions,
  verifyPassword,
} from "../src/lib/authCore.js";
import { getCookieValue } from "../src/lib/sessionCookie.js";
import { clearCookie, serializeCookie } from "../src/lib/httpResponse.js";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3001);
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON");
    error.status = 400;
    throw error;
  }
}

function cookieHeader(token) {
  return serializeCookie(SESSION_COOKIE, token, sessionCookieOptions());
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message });
  }

  const mode = body?.mode === "register" ? "register" : "login";
  const username = String(body?.username || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (!/^[a-z0-9_.-]{3,24}$/.test(username)) {
    return sendJson(res, 400, { error: "Username must be 3-24 chars: letters, digits, _ - . only" });
  }
  if (password.length < 6 || password.length > 128) {
    return sendJson(res, 400, { error: "Password must be 6-128 characters" });
  }

  try {
    let user;
    if (mode === "register") {
      const existing = await db.user.findUnique({ where: { username } });
      if (existing) return sendJson(res, 409, { error: "Username already taken" });
      const rows = await db.user.groupBy({ by: ["color"], _count: { color: true } });
      const usage = Object.fromEntries(rows.map((row) => [row.color, row._count.color]));
      user = await db.user.create({
        data: {
          username,
          passwordHash: hashPassword(password),
          color: pickColor(usage),
          createdAt: BigInt(Date.now()),
        },
      });
    } else {
      user = await db.user.findUnique({ where: { username } });
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return sendJson(res, 401, { error: "Invalid username or password" });
      }
    }

    const token = await createSession(user.id);
    return sendJson(res, 200, { user: publicUser(user) }, { "set-cookie": cookieHeader(token) });
  } catch (error) {
    // A concurrent registration can race the preflight username lookup.
    if (mode === "register" && error?.code === "P2002") {
      return sendJson(res, 409, { error: "Username already taken" });
    }
    console.error("Authentication request failed:", error);
    return sendJson(res, 500, { error: "Authentication service unavailable" });
  }
}

async function handleSession(req, res) {
  const token = getCookieValue(req.headers.cookie, SESSION_COOKIE);
  const auth = token ? await getAuthUserByToken(token) : null;

  if (req.method === "GET") {
    return sendJson(res, 200, { user: auth ? publicUser(auth.user) : null });
  }

  if (auth) {
    await db.session.deleteMany({ where: { id: auth.session.id } });
  }
  return sendJson(res, 200, { ok: true }, {
    "set-cookie": clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" }),
  });
}


async function requestAuth(req) {
  const token = getCookieValue(req.headers.cookie, SESSION_COOKIE);
  return token ? getAuthUserByToken(token) : null;
}

async function handleWorkspaces(req, res) {
  const auth = await requestAuth(req);
  if (!auth) return sendJson(res, 401, { error: "Not authenticated" });

  if (req.method === "GET") {
    const memberships = await db.workspaceMember.findMany({ where: { userId: auth.user.id } });
    const ids = memberships.map((membership) => membership.workspaceId);
    const workspaces = await db.workspace.findMany({
      where: { id: { in: ids } },
      orderBy: { updatedAt: "desc" },
    });
    const owners = await db.user.findMany({
      where: { id: { in: workspaces.map((workspace) => workspace.ownerId) } },
    });
    const ownerMap = Object.fromEntries(owners.map((owner) => [owner.id, publicUser(owner)]));
    const roleMap = Object.fromEntries(memberships.map((membership) => [membership.workspaceId, membership.role]));
    return sendJson(res, 200, {
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        ownerId: workspace.ownerId,
        owner: ownerMap[workspace.ownerId] || null,
        role: roleMap[workspace.id] || "viewer",
        createdAt: Number(workspace.createdAt),
        updatedAt: Number(workspace.updatedAt),
      })),
    });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message });
  }
  const name = String(body?.name || "").trim();
  if (!name || name.length > 120) return sendJson(res, 400, { error: "Name must be 1-120 characters" });
  const description = String(body?.description || "").slice(0, 500);
  const now = Date.now();
  const workspace = await db.workspace.create({
    data: { name, description, ownerId: auth.user.id, createdAt: BigInt(now), updatedAt: BigInt(now) },
  });
  await db.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: auth.user.id, role: "owner", joinedAt: BigInt(now) },
  });
  return sendJson(res, 201, {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      ownerId: workspace.ownerId,
      role: "owner",
      createdAt: Number(workspace.createdAt),
      updatedAt: Number(workspace.updatedAt),
    },
  });
}

async function handleWorkspaceJoin(req, res, workspaceId) {
  const auth = await requestAuth(req);
  if (!auth) return sendJson(res, 401, { error: "Not authenticated" });
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return sendJson(res, 404, { error: "Workspace not found" });
  const existing = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: auth.user.id } },
  });
  if (existing) return sendJson(res, 200, { ok: true, role: existing.role });
  const member = await db.workspaceMember.create({
    data: { workspaceId, userId: auth.user.id, role: "editor", joinedAt: BigInt(Date.now()) },
  });
  return sendJson(res, 201, { ok: true, role: member.role });
}

async function handleWorkspaceBootstrap(req, res, workspaceId) {
  const auth = await requestAuth(req);
  if (!auth) return sendJson(res, 401, { error: "Not authenticated" });
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: auth.user.id } },
  });
  if (!membership) return sendJson(res, 404, { error: "Workspace not found" });
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return sendJson(res, 404, { error: "Workspace not found" });
  const members = await db.workspaceMember.findMany({ where: { workspaceId } });
  const users = await db.user.findMany({ where: { id: { in: members.map((member) => member.userId) } } });
  const userMap = Object.fromEntries(users.map((user) => [user.id, publicUser(user)]));
  const docs = await db.document.findMany({
    where: { workspaceId, deleted: false },
    orderBy: { path: "asc" },
  });
  return sendJson(res, 200, {
    workspace: { id: workspace.id, name: workspace.name, description: workspace.description, ownerId: workspace.ownerId },
    role: membership.role,
    me: publicUser(auth.user),
    members: members.map((member) => ({
      user: userMap[member.userId] || { id: member.userId, username: "unknown", color: "#888" },
      role: member.role,
    })),
    docs: docs.map((doc) => ({
      id: doc.id,
      path: doc.path,
      isFolder: doc.isFolder,
      content: doc.isFolder ? "" : doc.content,
      docVersion: doc.docVersion,
      createdBy: doc.createdBy,
      updatedAt: Number(doc.updatedAt),
    })),
  });
}


import { validateFilePath } from "../src/shared/protocol.js";

async function requireWorkspaceMember(req, res, workspaceId, needEdit = false) {
  const auth = await requestAuth(req);
  if (!auth) {
    sendJson(res, 401, { error: "Not authenticated" });
    return null;
  }
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: auth.user.id } },
  });
  if (!membership) {
    sendJson(res, 404, { error: "Workspace not found or not a member" });
    return null;
  }
  if (needEdit && membership.role === "viewer") {
    sendJson(res, 403, { error: "Viewers cannot modify this workspace" });
    return null;
  }
  return { user: auth.user, role: membership.role };
}

async function notifyFsChanged(workspaceId, kind) {
  const token = process.env.INTERNAL_TOKEN || (process.env.NODE_ENV === "production" ? "" : "iw-internal-token");
  if (!token) return;
  const base = process.env.COLLAB_SERVICE_URL || "http://127.0.0.1:3004";
  try {
    await fetch(`${base}/internal/fs-changed`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": token },
      body: JSON.stringify({ workspaceId, kind }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // The filesystem mutation succeeds even when the collaboration service is temporarily unavailable.
  }
}

async function ensureParentFolders(workspaceId, path, now) {
  const parts = path.split("/");
  parts.pop();
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const parentPath = prefix + "/";
    const parent = await db.document.findUnique({
      where: { workspaceId_path: { workspaceId, path: parentPath } },
    });
    if (!parent) {
      await db.document.create({
        data: { workspaceId, path: parentPath, isFolder: true, content: "", createdAt: BigInt(now), updatedAt: BigInt(now) },
      });
    } else if (parent.deleted) {
      await db.document.update({
        where: { id: parent.id },
        data: { deleted: false, isFolder: true, content: "", updatedAt: BigInt(now) },
      });
    }
  }
}

async function handleCreateFile(req, res, workspaceId) {
  const ctx = await requireWorkspaceMember(req, res, workspaceId, true);
  if (!ctx) return;
  let body;
  try { body = await readJson(req); }
  catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
  const pathError = validateFilePath(body?.path);
  if (pathError) return sendJson(res, 400, { error: pathError });
  const path = body.path;
  const isFolder = !!body.isFolder;
  const content = isFolder ? "" : String(body.content ?? "");
  if (!isFolder && Buffer.byteLength(content, "utf8") > 512 * 1024) {
    return sendJson(res, 400, { error: "File too large (max 512KB)" });
  }
  try {
    const existing = await db.document.findUnique({ where: { workspaceId_path: { workspaceId, path } } });
    if (existing && !existing.deleted) return sendJson(res, 409, { error: "A file with this path already exists" });
    const now = Date.now();
    const doc = existing
      ? await db.document.update({ where: { id: existing.id }, data: { deleted: false, isFolder, content, updatedAt: BigInt(now), createdBy: ctx.user.id } })
      : await db.document.create({ data: { workspaceId, path, isFolder, content, createdBy: ctx.user.id, createdAt: BigInt(now), updatedAt: BigInt(now) } });
    await ensureParentFolders(workspaceId, path, now);
    void notifyFsChanged(workspaceId, "created");
    return sendJson(res, 201, { doc: { id: doc.id, path: doc.path, isFolder: doc.isFolder } });
  } catch (error) {
    if (error?.code === "P2002") return sendJson(res, 409, { error: "A file with this path already exists" });
    throw error;
  }
}

async function handleFileMutation(req, res, workspaceId, fileId) {
  const ctx = await requireWorkspaceMember(req, res, workspaceId, true);
  if (!ctx) return;
  const doc = await db.document.findFirst({ where: { id: fileId, workspaceId, deleted: false } });
  if (!doc) return sendJson(res, 404, { error: "File not found" });

  if (req.method === "DELETE") {
    const now = BigInt(Date.now());
    if (doc.isFolder) {
      await db.document.updateMany({ where: { workspaceId, path: { startsWith: doc.path } }, data: { deleted: true, updatedAt: now } });
    }
    await db.document.update({ where: { id: doc.id }, data: { deleted: true, updatedAt: now } });
    void notifyFsChanged(workspaceId, "deleted");
    return sendJson(res, 200, { ok: true });
  }

  let body;
  try { body = await readJson(req); }
  catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
  const pathError = validateFilePath(body?.path);
  if (pathError) return sendJson(res, 400, { error: pathError });
  const newPath = body.path;
  if (doc.isFolder && newPath.startsWith(doc.path)) {
    return sendJson(res, 400, { error: "A folder cannot be moved inside itself" });
  }
  const clash = await db.document.findUnique({ where: { workspaceId_path: { workspaceId, path: newPath } } });
  if (clash && clash.id !== doc.id) {
    return sendJson(res, 409, { error: clash.deleted ? "Target path belongs to a deleted item; recreate it or choose another path" : "Target path already exists" });
  }
  const now = Date.now();
  if (doc.isFolder) {
    const children = await db.document.findMany({ where: { workspaceId, path: { startsWith: doc.path } } });
    const movingIds = new Set(children.map((child) => child.id));
    const targetPaths = new Set(children.map((child) => newPath + child.path.slice(doc.path.length)));
    const destinationRows = await db.document.findMany({ where: { workspaceId, path: { startsWith: newPath } }, select: { id: true, path: true } });
    if (destinationRows.some((row) => targetPaths.has(row.path) && !movingIds.has(row.id))) {
      return sendJson(res, 409, { error: "A file or folder already exists at the destination path" });
    }
    // Move descendants first, matching the existing API behavior.
    for (const child of children) {
      await db.document.update({ where: { id: child.id }, data: { path: newPath + child.path.slice(doc.path.length), updatedAt: BigInt(now) } });
    }
  }
  try {
    await db.document.update({ where: { id: doc.id }, data: { path: newPath, updatedAt: BigInt(now) } });
  } catch (error) {
    if (error?.code === "P2002") return sendJson(res, 409, { error: "Target path already exists" });
    throw error;
  }
  await ensureParentFolders(workspaceId, newPath, now);
  void notifyFsChanged(workspaceId, "renamed");
  return sendJson(res, 200, { ok: true });
}

export function createApiServer() {
  return createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    try {
      if (req.method === "GET" && pathname === "/healthz") {
        return sendJson(res, 200, { status: "ok" });
      }
      if (pathname === "/api/auth" && req.method === "POST") {
        return await handleLogin(req, res);
      }
      if (pathname === "/api/auth/session" && (req.method === "GET" || req.method === "DELETE")) {
        return await handleSession(req, res);
      }
      if (pathname === "/api/workspaces" && (req.method === "GET" || req.method === "POST")) {
        return await handleWorkspaces(req, res);
      }
      const filesMatch = pathname.match(/^\\/api\\/workspaces\\/([^/]+)\\/files$/);
      if (filesMatch && req.method === "POST") {
        return await handleCreateFile(req, res, decodeURIComponent(filesMatch[1]));
      }
      const fileMatch = pathname.match(/^\\/api\\/workspaces\\/([^/]+)\\/files\\/([^/]+)$/);
      if (fileMatch && (req.method === "PATCH" || req.method === "DELETE")) {
        return await handleFileMutation(req, res, decodeURIComponent(fileMatch[1]), decodeURIComponent(fileMatch[2]));
      }
      const joinMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/join$/);
      if (joinMatch && req.method === "POST") {
        return await handleWorkspaceJoin(req, res, decodeURIComponent(joinMatch[1]));
      }
      const bootstrapMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/bootstrap$/);
      if (bootstrapMatch && req.method === "GET") {
        return await handleWorkspaceBootstrap(req, res, decodeURIComponent(bootstrapMatch[1]));
      }
      if (pathname.startsWith("/api/")) {
        return sendJson(res, 501, { error: "This API route has not been migrated from Next.js yet." });
      }
      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      console.error("Unhandled API error:", error);
      if (!res.headersSent) return sendJson(res, 500, { error: "Internal server error" });
      res.destroy(error);
    }
  });
}

if (process.argv[1] && new URL(import.meta.url).pathname.endsWith("/server/index.js")) {
  const server = createApiServer();
  server.listen(port, host, () => {
    console.log(`Node API server listening on http://${host}:${port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
