// /api/notifications — persistent per-user notifications.
import { db } from "../lib/db.js";
import { fail, json, readJson } from "../lib/http.js";
import { requireAuth } from "../lib/apiHelpers.js";
import { shapeNotification } from "../lib/notifications.js";

export function registerNotificationRoutes(router) {
  // GET /api/notifications?unread=1&limit=50
  router.get("/api/notifications", async (req, res, { url }) => {
    const user = await requireAuth(req);
    const unreadOnly = url.searchParams.get("unread") === "1";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

    const where = { userId: user.id };
    if (unreadOnly) where.readAt = BigInt(0);
    const rows = await db.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    const unread = await db.notification.count({ where: { userId: user.id, readAt: BigInt(0) } });
    return json(res, { notifications: rows.map(shapeNotification), unread });
  });

  // POST /api/notifications/read { ids?: string[], all?: boolean }
  router.post("/api/notifications/read", async (req, res) => {
    const user = await requireAuth(req);
    const body = await readJson(req);
    const now = BigInt(Date.now());
    if (body.all) {
      await db.notification.updateMany({
        where: { userId: user.id, readAt: BigInt(0) },
        data: { readAt: now },
      });
      return json(res, { ok: true });
    }
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string").slice(0, 200) : [];
    if (!ids.length) throw fail("ids must be a non-empty array");
    await db.notification.updateMany({
      where: { userId: user.id, id: { in: ids } },
      data: { readAt: now },
    });
    return json(res, { ok: true });
  });

  // DELETE /api/notifications/:notifId
  router.delete("/api/notifications/:notifId", async (req, res, { params }) => {
    const user = await requireAuth(req);
    await db.notification.deleteMany({ where: { id: params.notifId, userId: user.id } });
    return json(res, { ok: true });
  });
}
