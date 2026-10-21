// /api/workspaces — workspace metadata, membership, bootstrap, history, restore.

import { db } from "../lib/db.js";
import { publicUser } from "../lib/auth.js";
import { fail, json, readJson } from "../lib/http.js";
import { requireAuth, requireMember } from "../lib/apiHelpers.js";
import { serviceClient } from "../lib/serviceClient.js";
import { createHash, randomBytes } from "node:crypto";

const ROLES = ["editor", "viewer"];
const INVITE_TTL_HOURS = 24 * 7;

function hashInvite(code) {
  return createHash("sha256").update(String(code)).digest("hex");
}

export function registerWorkspaceRoutes(router) {
  // GET /api/workspaces?archived=1 → workspaces I am a member of
  router.get("/api/workspaces", async (req, res, { url }) => {
    const user = await requireAuth(req);
    const wantArchived = url?.searchParams.get("archived") === "1";

    const memberships = await db.workspaceMember.findMany({
      where: { userId: user.id },
    });
    const ids = memberships.map((m) => m.workspaceId);
    const all = await db.workspace.findMany({
      where: { id: { in: ids } },
      orderBy: { updatedAt: "desc" },
    });
    const workspaces = all.filter((w) => (wantArchived ? Number(w.archivedAt) > 0 : Number(w.archivedAt) === 0));
    const owners = await db.user.findMany({
      where: { id: { in: workspaces.map((w) => w.ownerId) } },
    });
    const ownerMap = Object.fromEntries(owners.map((o) => [o.id, publicUser(o)]));
    const roleMap = Object.fromEntries(
      memberships.map((m) => [m.workspaceId, m.role])
    );
    const counts = await db.workspaceMember.groupBy({
      by: ["workspaceId"],
      where: { workspaceId: { in: ids } },
      _count: { _all: true },
    });
    const countMap = Object.fromEntries(counts.map((c) => [c.workspaceId, c._count._all]));

    return json(res, {
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        ownerId: w.ownerId,
        owner: ownerMap[w.ownerId] || null,
        role: roleMap[w.id] || "viewer",
        allowIdJoin: w.allowIdJoin,
        archived: Number(w.archivedAt) > 0,
        memberCount: countMap[w.id] || 0,
        createdAt: Number(w.createdAt),
        updatedAt: Number(w.updatedAt),
      })),
    });
  });

  // POST /api/workspaces { name, description?, templateId? } → create (creator becomes owner)
  router.post("/api/workspaces", async (req, res) => {
    const user = await requireAuth(req);
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    if (!name || name.length > 120) throw fail("Name must be 1-120 characters");
    const description = String(body.description || "").slice(0, 500);
    const now = Date.now();

    const ws = await db.workspace.create({
      data: {
        name,
        description,
        ownerId: user.id,
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });
    await db.workspaceMember.create({
      data: {
        workspaceId: ws.id,
        userId: user.id,
        role: "owner",
        joinedAt: BigInt(now),
      },
    });

    if (body.templateId) {
      await seedFromTemplate(ws.id, user.id, String(body.templateId));
    }

    return json(
      res,
      {
        workspace: {
          id: ws.id,
          name: ws.name,
          description: ws.description,
          ownerId: ws.ownerId,
          role: "owner",
          createdAt: Number(ws.createdAt),
          updatedAt: Number(ws.updatedAt),
        },
      },
      201
    );
  });

  // GET /api/workspaces/:id → meta + members + my role
  router.get("/api/workspaces/:id", async (req, res, { params }) => {
    const { id } = params;
    const { user } = await requireMember(req, id);

    const ws = await db.workspace.findUnique({ where: { id } });
    if (!ws) throw fail("Workspace not found", 404);
    const { members, userMap } = await loadMembers(id);

    return json(res, {
      workspace: {
        id: ws.id,
        name: ws.name,
        description: ws.description,
        ownerId: ws.ownerId,
        allowIdJoin: ws.allowIdJoin,
        createdAt: Number(ws.createdAt),
        updatedAt: Number(ws.updatedAt),
      },
      role: members.find((m) => m.userId === user.id)?.role || "viewer",
      me: publicUser(user),
      members: members.map((m) => ({
        user: userMap[m.userId] || { id: m.userId, username: "unknown", color: "#888" },
        role: m.role,
        joinedAt: Number(m.joinedAt),
      })),
    });
  });

  // DELETE /api/workspaces/:id → owner only
  router.delete("/api/workspaces/:id", async (req, res, { params }) => {
    const { id } = params;
    const ctx = await requireMember(req, id);
    if (ctx.role !== "owner") throw fail("Only the owner can delete a workspace", 403);

    await db.workspaceMember.deleteMany({ where: { workspaceId: id } });
    await db.document.deleteMany({ where: { workspaceId: id } });
    await db.notification.deleteMany({ where: { workspaceId: id } });
    await db.asset.deleteMany({ where: { workspaceId: id } });
    await db.shareLink.deleteMany({ where: { workspaceId: id } });
    await db.webhookDelivery.deleteMany({ where: { workspaceId: id } });
    await db.webhook.deleteMany({ where: { workspaceId: id } });
    await db.automationRule.deleteMany({ where: { workspaceId: id } });
    await db.scheduledJob.deleteMany({ where: { workspaceId: id } });
    await db.workspaceInvite.deleteMany({ where: { workspaceId: id } });
    await db.workspace.delete({ where: { id } });
    return json(res, { ok: true });
  });

  // PATCH /api/workspaces/:id { name?, description? } → owner/editor
  router.patch("/api/workspaces/:id", async (req, res, { params }) => {
    const { id } = params;
    const ctx = await requireMember(req, id, true);
    const body = await readJson(req);
    const data = {};
    if (typeof body.name === "string" && body.name.trim())
      data.name = body.name.trim().slice(0, 120);
    if (typeof body.description === "string")
      data.description = body.description.slice(0, 500);
    if (typeof body.allowIdJoin === "boolean") {
      if (ctx.role !== "owner") throw fail("Only the owner can change the join policy", 403);
      data.allowIdJoin = body.allowIdJoin;
    }
    if (typeof body.archived === "boolean") {
      if (ctx.role !== "owner") throw fail("Only the owner can archive a workspace", 403);
      data.archivedAt = body.archived ? BigInt(Date.now()) : BigInt(0);
    }
    if (!Object.keys(data).length) throw fail("Nothing to update");
    data.updatedAt = Date.now();
    const ws = await db.workspace.update({ where: { id }, data });
    return json(res, {
      workspace: {
        id: ws.id,
        name: ws.name,
        description: ws.description,
        ownerId: ws.ownerId,
        allowIdJoin: ws.allowIdJoin,
        createdAt: Number(ws.createdAt),
        updatedAt: Number(ws.updatedAt),
      },
    });
  });

  // POST /api/workspaces/:id/join
  // Join a workspace by ID (share-by-id model). First join becomes an editor;
  // re-joining is idempotent. Owners keep their role.
  router.post("/api/workspaces/:id/join", async (req, res, { params }) => {
    const { id } = params;
    const user = await requireAuth(req);

    const ws = await db.workspace.findUnique({ where: { id } });
    if (!ws) throw fail("Workspace not found", 404);

    const existing = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: id, userId: user.id } },
    });
    if (existing) return json(res, { ok: true, role: existing.role });
    if (!ws.allowIdJoin)
      throw fail("This workspace is invite-only — ask the owner for an invite link", 403);

    const member = await db.workspaceMember.create({
      data: {
        workspaceId: id,
        userId: user.id,
        role: "editor",
        joinedAt: BigInt(Date.now()),
      },
    });
    return json(res, { ok: true, role: member.role }, 201);
  });

  // GET /api/workspaces/:id/bootstrap
  // Everything a client needs to open a workspace in one round trip:
  // meta, role, members, and the full document tree (with contents).
  // Canvas objects + canvas version arrive via the socket `ws:join` ack.
  router.get("/api/workspaces/:id/bootstrap", async (req, res, { params }) => {
    const { id } = params;
    const ctx = await requireMember(req, id);

    const ws = await db.workspace.findUnique({ where: { id } });
    if (!ws) throw fail("Workspace not found", 404);

    const { members, userMap } = await loadMembers(id);

    const docs = await db.document.findMany({
      where: { workspaceId: id, deleted: false },
      orderBy: { path: "asc" },
    });

    return json(res, {
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
  });

  // GET /api/workspaces/:id/versions?limit=200&before=<version>
  // Recent operation history (newest first) with user attribution.
  router.get("/api/workspaces/:id/versions", async (req, res, { params, url }) => {
    const { id } = params;
    await requireMember(req, id);

    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1),
      500
    );
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

    return json(res, {
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
  });

  // POST /api/workspaces/:id/restore { version }
  // Delegates to the collaboration service, which:
  //   1. computes the workspace state at `version` (latest snapshot ≤ version
  //      + replay of subsequent operations)
  //   2. diffs it against the current state
  //   3. emits the difference as new (regular, broadcast) operations
  router.post("/api/workspaces/:id/restore", async (req, res, { params }) => {
    const { id } = params;
    const ctx = await requireMember(req, id, true);

    const body = await readJson(req);
    const version = parseInt(body.version, 10);
    if (!isFinite(version) || version < 0) throw fail("Invalid version");

    const result = await serviceClient.restore(id, version, ctx.user.id, ctx.user.username);
    if (!result.ok) {
      throw fail(
        result.data?.error || "Restore failed (is the collaboration service running?)",
        502
      );
    }
    return json(res, result.data);
  });

  // PATCH /api/workspaces/:id/members/:userId { role } → owner only
  router.patch("/api/workspaces/:id/members/:userId", async (req, res, { params }) => {
    const { id, userId } = params;
    const ctx = await requireMember(req, id, true);
    if (ctx.role !== "owner") throw fail("Only the owner can change member roles", 403);
    const body = await readJson(req);
    const role = String(body.role || "");
    if (!ROLES.includes(role)) throw fail("Role must be editor or viewer");
    const member = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: id, userId } },
    });
    if (!member) throw fail("Member not found", 404);
    if (member.role === "owner") throw fail("The owner's role cannot be changed", 400);
    await db.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: id, userId } },
      data: { role },
    });
    return json(res, { ok: true, role });
  });

  // DELETE /api/workspaces/:id/members/:userId → owner removes, or anyone leaves
  router.delete("/api/workspaces/:id/members/:userId", async (req, res, { params }) => {
    const { id, userId } = params;
    const ctx = await requireMember(req, id, true);
    const self = ctx.user.id === userId;
    if (!self && ctx.role !== "owner") throw fail("Only the owner can remove members", 403);
    const member = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: id, userId } },
    });
    if (!member) throw fail("Member not found", 404);
    if (member.role === "owner") throw fail("The owner cannot leave — transfer ownership first", 400);
    await db.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId: id, userId } },
    });
    return json(res, { ok: true });
  });

  // POST /api/workspaces/:id/transfer { userId } → owner only
  router.post("/api/workspaces/:id/transfer", async (req, res, { params }) => {
    const { id } = params;
    const ctx = await requireMember(req, id, true);
    if (ctx.role !== "owner") throw fail("Only the owner can transfer ownership", 403);
    const body = await readJson(req);
    const userId = String(body.userId || "");
    const target = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: id, userId } },
    });
    if (!target) throw fail("That user is not a member of this workspace", 404);
    const now = Date.now();
    await db.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: id, userId: ctx.user.id } },
      data: { role: "editor" },
    });
    await db.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: id, userId } },
      data: { role: "owner" },
    });
    await db.workspace.update({ where: { id }, data: { ownerId: userId, updatedAt: BigInt(now) } });
    return json(res, { ok: true });
  });

  // POST /api/workspaces/:id/invites { role?, expiresInHours?, maxUses? } → owner
  router.post("/api/workspaces/:id/invites", async (req, res, { params }) => {
    const { id } = params;
    const ctx = await requireMember(req, id, true);
    if (ctx.role !== "owner") throw fail("Only the owner can create invites", 403);
    const body = await readJson(req);
    const role = ROLES.includes(body.role) ? body.role : "editor";
    const hours = Math.min(Math.max(Number(body.expiresInHours) || INVITE_TTL_HOURS, 1), 24 * 30);
    const maxUses = Math.min(Math.max(parseInt(body.maxUses, 10) || 1, 1), 100);
    const code = randomBytes(18).toString("base64url");
    const now = Date.now();
    const invite = await db.workspaceInvite.create({
      data: {
        workspaceId: id,
        code: hashInvite(code),
        role,
        createdBy: ctx.user.id,
        expiresAt: BigInt(now + hours * 3600 * 1000),
        maxUses,
        createdAt: BigInt(now),
      },
    });
    return json(
      res,
      {
        invite: {
          id: invite.id,
          role,
          expiresAt: Number(invite.expiresAt),
          maxUses,
          uses: 0,
        },
        code,
        path: `/?invite=${code}`,
      },
      201
    );
  });

  // GET /api/workspaces/:id/invites → owner
  router.get("/api/workspaces/:id/invites", async (req, res, { params }) => {
    const { id } = params;
    const ctx = await requireMember(req, id);
    if (ctx.role !== "owner") throw fail("Only the owner can view invites", 403);
    const invites = await db.workspaceInvite.findMany({
      where: { workspaceId: id, revoked: false },
      orderBy: { createdAt: "desc" },
    });
    return json(res, {
      invites: invites.map((i) => ({
        id: i.id,
        role: i.role,
        expiresAt: Number(i.expiresAt),
        maxUses: i.maxUses,
        uses: i.uses,
        expired: Number(i.expiresAt) < Date.now(),
      })),
    });
  });

  // DELETE /api/workspaces/:id/invites/:inviteId → owner revokes
  router.delete("/api/workspaces/:id/invites/:inviteId", async (req, res, { params }) => {
    const { id, inviteId } = params;
    const ctx = await requireMember(req, id, true);
    if (ctx.role !== "owner") throw fail("Only the owner can revoke invites", 403);
    await db.workspaceInvite.updateMany({
      where: { id: inviteId, workspaceId: id },
      data: { revoked: true },
    });
    return json(res, { ok: true });
  });

  // GET /api/invites/:code → preview an invite (requires sign-in)
  router.get("/api/invites/:code", async (req, res, { params }) => {
    const user = await requireAuth(req);
    const invite = await findInvite(params.code);
    if (!invite) throw fail("This invite is invalid or has expired", 404);
    const ws = await db.workspace.findUnique({ where: { id: invite.workspaceId } });
    if (!ws) throw fail("Workspace not found", 404);
    const existing = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId: user.id } },
    });
    return json(res, {
      workspace: { id: ws.id, name: ws.name, description: ws.description },
      role: invite.role,
      alreadyMember: !!existing,
    });
  });

  // POST /api/invites/:code/accept → join via invite
  router.post("/api/invites/:code/accept", async (req, res, { params }) => {
    const user = await requireAuth(req);
    const invite = await findInvite(params.code);
    if (!invite) throw fail("This invite is invalid or has expired", 404);
    const existing = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId: user.id } },
    });
    if (existing) {
      return json(res, { ok: true, workspaceId: invite.workspaceId, role: existing.role });
    }
    await db.workspaceMember.create({
      data: {
        workspaceId: invite.workspaceId,
        userId: user.id,
        role: invite.role,
        joinedAt: BigInt(Date.now()),
      },
    });
    await db.workspaceInvite.update({
      where: { id: invite.id },
      data: { uses: { increment: 1 } },
    });
    return json(res, { ok: true, workspaceId: invite.workspaceId, role: invite.role }, 201);
  });

  // POST /api/workspaces/:id/members/bulk { usernames: [], role } → owner
  router.post("/api/workspaces/:id/members/bulk", async (req, res, { params }) => {
    const { id } = params;
    const ctx = await requireMember(req, id, true);
    if (ctx.role !== "owner") throw fail("Only the owner can add members", 403);
    const body = await readJson(req);
    const role = ROLES.includes(body.role) ? body.role : "editor";
    const usernames = [...new Set((Array.isArray(body.usernames) ? body.usernames : [])
      .map((u) => String(u).trim().toLowerCase())
      .filter(Boolean))].slice(0, 200);
    if (!usernames.length) throw fail("Provide at least one username");

    const users = await db.user.findMany({ where: { username: { in: usernames } } });
    const userMap = new Map(users.map((u) => [u.username, u]));
    const existing = await db.workspaceMember.findMany({ where: { workspaceId: id } });
    const existingSet = new Set(existing.map((m) => m.userId));

    const added = [];
    const alreadyMember = [];
    const missing = [];
    const now = BigInt(Date.now());
    for (const username of usernames) {
      const u = userMap.get(username);
      if (!u) {
        missing.push(username);
        continue;
      }
      if (existingSet.has(u.id)) {
        alreadyMember.push(username);
        continue;
      }
      await db.workspaceMember.create({
        data: { workspaceId: id, userId: u.id, role, joinedAt: now },
      });
      added.push(username);
    }
    return json(res, { added, alreadyMember, missing, role });
  });

  // GET /api/workspaces/:id/trash → deleted documents (+ canvas object count)
  router.get("/api/workspaces/:id/trash", async (req, res, { params }) => {
    const { id } = params;
    await requireMember(req, id);
    const docs = await db.document.findMany({
      where: { workspaceId: id, deleted: true },
      orderBy: { deletedAt: "desc" },
    });
    const users = await db.user.findMany({
      where: { id: { in: [...new Set(docs.map((d) => d.createdBy))] } },
    });
    const userMap = Object.fromEntries(users.map((u) => [u.id, publicUser(u)]));
    const canvasTrash = await db.canvasObject.count({ where: { workspaceId: id, deleted: true } });
    return json(res, {
      documents: docs.map((d) => ({
        id: d.id,
        path: d.path,
        isFolder: d.isFolder,
        deletedAt: Number(d.deletedAt),
        createdBy: d.createdBy,
        user: userMap[d.createdBy] || null,
      })),
      canvasTrash,
    });
  });

  // POST /api/workspaces/:id/trash/restore { documentId }
  router.post("/api/workspaces/:id/trash/restore", async (req, res, { params }) => {
    const { id } = params;
    await requireMember(req, id, true);
    const body = await readJson(req);
    const documentId = String(body.documentId || "");
    const doc = await db.document.findFirst({ where: { id: documentId, workspaceId: id, deleted: true } });
    if (!doc) throw fail("Deleted item not found", 404);
    const now = BigInt(Date.now());

    const restored = [];
    if (doc.isFolder) {
      const descendants = await db.document.findMany({
        where: { workspaceId: id, deleted: true, path: { startsWith: doc.path } },
      });
      for (const d of descendants) {
        await db.document.update({ where: { id: d.id }, data: { deleted: false, deletedAt: BigInt(0) } });
        restored.push(d.id);
      }
    } else {
      await db.document.update({ where: { id: doc.id }, data: { deleted: false, deletedAt: BigInt(0) } });
      restored.push(doc.id);
    }
    serviceClient.notifyFsChanged(id, "restored").catch(() => {});
    return json(res, { ok: true, restored });
  });

  // DELETE /api/workspaces/:id/trash?documentId= → purge (permanent)
  router.delete("/api/workspaces/:id/trash", async (req, res, { params, url }) => {
    const { id } = params;
    await requireMember(req, id, true);
    const documentId = url.searchParams.get("documentId");
    if (documentId) {
      const doc = await db.document.findFirst({ where: { id: documentId, workspaceId: id, deleted: true } });
      if (!doc) throw fail("Deleted item not found", 404);
      await db.document.deleteMany({ where: { workspaceId: id, deleted: true, path: { startsWith: doc.path } } });
    } else {
      await db.document.deleteMany({ where: { workspaceId: id, deleted: true } });
    }
    return json(res, { ok: true });
  });

  // GET /api/workspaces/:id/analytics
  router.get("/api/workspaces/:id/analytics", async (req, res, { params }) => {
    const { id } = params;
    await requireMember(req, id);
    const until = Date.now();
    const since = BigInt(until - 30 * 86400_000);

    const [ops, docOps, docs, canvasObjects, commentCount, assetAgg, members] = await Promise.all([
      db.operation.findMany({ where: { workspaceId: id, createdAt: { gte: since } }, take: 5000, orderBy: { createdAt: "asc" } }),
      db.documentOperation.findMany({ where: { workspaceId: id, createdAt: { gte: since } }, take: 5000, orderBy: { createdAt: "asc" } }),
      db.document.findMany({ where: { workspaceId: id, deleted: false } }),
      db.canvasObject.count({ where: { workspaceId: id, deleted: false } }),
      db.canvasObject.count({ where: { workspaceId: id, deleted: false, type: "comment" } }),
      db.asset.aggregate({ where: { workspaceId: id }, _sum: { bytes: true }, _count: { _all: true } }),
      db.workspaceMember.count({ where: { workspaceId: id } }),
    ]);

    const toDay = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);
    const byDay = new Map();
    const editorCounts = new Map();
    const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    for (const o of ops) {
      const day = toDay(o.createdAt);
      byDay.set(day, (byDay.get(day) || 0) + 1);
      bump(editorCounts, o.userId);
    }
    for (const o of docOps) {
      const day = toDay(o.createdAt);
      byDay.set(day, (byDay.get(day) || 0) + 1);
      bump(editorCounts, o.userId);
    }

    const topIds = [...editorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const users = await db.user.findMany({ where: { id: { in: topIds.map(([uid]) => uid) } } });
    const userMap = Object.fromEntries(users.map((u) => [u.id, publicUser(u)]));

    const liveDocs = docs.filter((d) => !d.isFolder);
    return json(res, {
      activity: [...byDay.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
      // Dense 30-day timeline (oldest → newest) so clients can chart gaps.
      series: Array.from({ length: 30 }, (_, i) => {
        const date = toDay(until - (29 - i) * 86400_000);
        return { date, count: byDay.get(date) || 0 };
      }),
      topEditors: topIds.map(([uid, count]) => ({ user: userMap[uid] || { id: uid }, count })),
      totals: {
        operations: ops.length,
        documentOperations: docOps.length,
        files: liveDocs.length,
        folders: docs.length - liveDocs.length,
        fileBytes: liveDocs.reduce((n, d) => n + Buffer.byteLength(d.content), 0),
        canvasObjects,
        comments: commentCount,
        assets: assetAgg._count._all,
        assetBytes: assetAgg._sum.bytes || 0,
        members,
      },
    });
  });

  // GET /api/templates → templates visible to me
  router.get("/api/templates", async (req, res) => {
    await requireAuth(req);
    const rows = await db.workspaceTemplate.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    return json(res, {
      templates: rows.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        createdBy: t.createdBy,
        createdAt: Number(t.createdAt),
        fileCount: (safeJson(t.payload).files || []).length,
        canvasCount: (safeJson(t.payload).canvas || []).length,
      })),
    });
  });

  // POST /api/templates { name, description?, workspaceId } → snapshot a workspace
  router.post("/api/templates", async (req, res) => {
    const body = await readJson(req);
    const workspaceId = String(body.workspaceId || "");
    const ctx = await requireMember(req, workspaceId, true);
    if (ctx.role !== "owner") throw fail("Only the workspace owner can save a template", 403);
    const name = String(body.name || "").trim();
    if (!name || name.length > 120) throw fail("Name must be 1-120 characters");

    const docs = await db.document.findMany({ where: { workspaceId, deleted: false } });
    const objects = await db.canvasObject.findMany({ where: { workspaceId, deleted: false }, orderBy: { zIndex: "asc" } });
    const payload = JSON.stringify({
      files: docs.map((d) => ({ path: d.path, isFolder: d.isFolder, content: d.isFolder ? "" : d.content })),
      canvas: objects.map((o) => ({ type: o.type, z: o.zIndex, payload: safeJson(o.payload) })),
    });
    const template = await db.workspaceTemplate.create({
      data: {
        name,
        description: String(body.description || "").slice(0, 500),
        createdBy: ctx.user.id,
        payload,
        createdAt: BigInt(Date.now()),
      },
    });
    return json(res, { template: { id: template.id, name: template.name } }, 201);
  });

  // DELETE /api/templates/:templateId
  router.delete("/api/templates/:templateId", async (req, res, { params }) => {
    const user = await requireAuth(req);
    const tpl = await db.workspaceTemplate.findUnique({ where: { id: params.templateId } });
    if (!tpl) throw fail("Template not found", 404);
    if (tpl.createdBy && tpl.createdBy !== user.id) throw fail("Only the creator can delete this template", 403);
    await db.workspaceTemplate.delete({ where: { id: tpl.id } });
    return json(res, { ok: true });
  });
}

async function findInvite(code) {
  if (!code || String(code).length > 200) return null;
  const invite = await db.workspaceInvite.findUnique({ where: { code: hashInvite(code) } });
  if (!invite || invite.revoked) return null;
  if (Number(invite.expiresAt) < Date.now()) return null;
  if (invite.uses >= invite.maxUses) return null;
  return invite;
}

async function loadMembers(workspaceId) {
  const members = await db.workspaceMember.findMany({
    where: { workspaceId },
  });
  const users = await db.user.findMany({
    where: { id: { in: members.map((m) => m.userId) } },
  });
  const userMap = Object.fromEntries(users.map((u) => [u.id, publicUser(u)]));
  return { members, userMap };
}

function safeJson(str) {
  try {
    return JSON.parse(str || "{}");
  } catch {
    return {};
  }
}

// Seed a new workspace from a template: documents via Prisma, canvas objects
// replayed as CREATE operations through the collaboration sequencer.
async function seedFromTemplate(workspaceId, userId, templateId) {
  const tpl = await db.workspaceTemplate.findUnique({ where: { id: templateId } });
  if (!tpl) return;
  const payload = safeJson(tpl.payload);
  const now = BigInt(Date.now());

  const files = Array.isArray(payload.files) ? payload.files.slice(0, 2000) : [];
  const folders = new Set();
  for (const f of files) {
    const parts = String(f.path || "").split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/") + "/");
    if (f.isFolder) folders.add(parts.join("/") + "/");
  }
  for (const folderPath of folders) {
    await db.document.create({
      data: { workspaceId, path: folderPath, isFolder: true, createdBy: userId, createdAt: now, updatedAt: now },
    }).catch(() => {});
  }
  for (const f of files) {
    if (f.isFolder) continue;
    const path = String(f.path || "");
    if (!path || path.endsWith("/")) continue;
    const created = await db.document.create({
      data: {
        workspaceId,
        path,
        isFolder: false,
        content: String(f.content || ""),
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      },
    }).catch(() => null);
    if (created) {
      await db.documentSnapshot.create({
        data: { documentId: created.id, workspaceId, version: 0, content: created.content, createdAt: now },
      }).catch(() => {});
    }
  }

  const canvas = Array.isArray(payload.canvas) ? payload.canvas.slice(0, 1000) : [];
  if (canvas.length) {
    serviceClient.seedCanvas(workspaceId, userId, canvas).catch(() => {});
  }
}