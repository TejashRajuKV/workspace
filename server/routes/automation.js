// /api/workspaces/:id/webhooks|schedules|rules — AI-free automation management.
import { db } from "../lib/db.js";
import { fail, json, readJson } from "../lib/http.js";
import { requireMember } from "../lib/apiHelpers.js";
import { randomSecret, sealSecret } from "../lib/secrets.js";

const EVENTS = [
  "file.created",
  "file.updated",
  "file.deleted",
  "comment.created",
  "github.pull",
  "github.push",
  "board.restored",
  "*",
];

function requireOwner(ctx) {
  if (ctx.role !== "owner") throw fail("Only the workspace owner can manage automation", 403);
}

function validUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanEvents(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(",");
  const out = list.map((e) => String(e).trim()).filter((e) => EVENTS.includes(e));
  return [...new Set(out)].join(",");
}

export function registerAutomationRoutes(router) {
  // ---- Webhooks -----------------------------------------------------------
  router.get("/api/workspaces/:id/webhooks", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    const hooks = await db.webhook.findMany({ where: { workspaceId: params.id } });
    const counts = await db.webhookDelivery.groupBy({
      by: ["webhookId", "status"],
      where: { workspaceId: params.id },
      _count: { _all: true },
    });
    const stat = {};
    for (const c of counts) {
      stat[c.webhookId] = stat[c.webhookId] || { pending: 0, delivered: 0, failed: 0 };
      stat[c.webhookId][c.status] = c._count._all;
    }
    return json(res, {
      webhooks: hooks.map((h) => shapeHook(h, stat[h.id])),
      events: EVENTS,
    });
  });

  router.post("/api/workspaces/:id/webhooks", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    const body = await readJson(req);
    if (!validUrl(body.url)) throw fail("A valid http(s) URL is required");
    const events = cleanEvents(body.events);
    if (!events) throw fail("At least one event is required");
    const secret = typeof body.secret === "string" && body.secret.length >= 16 ? body.secret : randomSecret();
    const hook = await db.webhook.create({
      data: {
        workspaceId: params.id,
        url: String(body.url),
        secret: sealSecret(secret),
        events,
        createdBy: ctx.user.id,
        createdAt: BigInt(Date.now()),
      },
    });
    // Secret is returned exactly once.
    return json(res, { webhook: shapeHook(hook), secret }, 201);
  });

  router.patch("/api/workspaces/:id/webhooks/:hookId", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    const body = await readJson(req);
    const data = {};
    if (body.url !== undefined) {
      if (!validUrl(body.url)) throw fail("A valid http(s) URL is required");
      data.url = String(body.url);
    }
    if (body.events !== undefined) {
      const events = cleanEvents(body.events);
      if (!events) throw fail("At least one event is required");
      data.events = events;
    }
    if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
    if (!Object.keys(data).length) throw fail("Nothing to update");
    await db.webhook.updateMany({ where: { id: params.hookId, workspaceId: params.id }, data });
    return json(res, { ok: true });
  });

  router.delete("/api/workspaces/:id/webhooks/:hookId", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    await db.webhook.deleteMany({ where: { id: params.hookId, workspaceId: params.id } });
    await db.webhookDelivery.deleteMany({ where: { webhookId: params.hookId } });
    return json(res, { ok: true });
  });

  router.get("/api/workspaces/:id/webhooks/:hookId/deliveries", async (req, res, { params, url }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 25, 1), 100);
    const rows = await db.webhookDelivery.findMany({
      where: { webhookId: params.hookId, workspaceId: params.id },
      orderBy: { id: "desc" },
      take: limit,
    });
    return json(res, { deliveries: rows.map(shapeDelivery) });
  });

  // ---- Schedules ----------------------------------------------------------
  router.get("/api/workspaces/:id/schedules", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    const jobs = await db.scheduledJob.findMany({ where: { workspaceId: params.id } });
    return json(res, { schedules: jobs.map(shapeJob) });
  });

  router.post("/api/workspaces/:id/schedules", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    const body = await readJson(req);
    const hours = Math.min(Math.max(Number(body.intervalHours) || 24, 1), 720);
    const now = Date.now();
    const job = await db.scheduledJob.create({
      data: {
        workspaceId: params.id,
        kind: "export",
        intervalMs: Math.round(hours * 3600_000),
        createdBy: ctx.user.id,
        nextRunAt: BigInt(now + Math.round(hours * 3600_000)),
        createdAt: BigInt(now),
      },
    });
    return json(res, { schedule: shapeJob(job) }, 201);
  });

  router.patch("/api/workspaces/:id/schedules/:jobId", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    const body = await readJson(req);
    const data = {};
    if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
    if (body.intervalHours !== undefined) {
      const hours = Math.min(Math.max(Number(body.intervalHours) || 24, 1), 720);
      data.intervalMs = Math.round(hours * 3600_000);
      data.nextRunAt = BigInt(Date.now() + data.intervalMs);
    }
    if (!Object.keys(data).length) throw fail("Nothing to update");
    await db.scheduledJob.updateMany({ where: { id: params.jobId, workspaceId: params.id }, data });
    return json(res, { ok: true });
  });

  router.delete("/api/workspaces/:id/schedules/:jobId", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    await db.scheduledJob.deleteMany({ where: { id: params.jobId, workspaceId: params.id } });
    return json(res, { ok: true });
  });

  // ---- Rules --------------------------------------------------------------
  const TRIGGERS = ["file.created", "file.updated", "comment.created", "github.pull", "github.push", "*"];
  const ACTIONS = ["webhook", "notify"];

  router.get("/api/workspaces/:id/rules", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    const rules = await db.automationRule.findMany({ where: { workspaceId: params.id } });
    return json(res, { rules: rules.map(shapeRule), triggers: TRIGGERS, actions: ACTIONS });
  });

  router.post("/api/workspaces/:id/rules", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    const body = await readJson(req);
    if (!TRIGGERS.includes(body.trigger)) throw fail("Unknown trigger");
    if (!ACTIONS.includes(body.action)) throw fail("Unknown action");
    const rule = await db.automationRule.create({
      data: {
        workspaceId: params.id,
        name: String(body.name || "").slice(0, 120),
        trigger: body.trigger,
        action: body.action,
        config: JSON.stringify(body.config || {}),
        createdBy: ctx.user.id,
        createdAt: BigInt(Date.now()),
      },
    });
    return json(res, { rule: shapeRule(rule) }, 201);
  });

  router.patch("/api/workspaces/:id/rules/:ruleId", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    const body = await readJson(req);
    const data = {};
    if (body.name !== undefined) data.name = String(body.name).slice(0, 120);
    if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
    if (body.config !== undefined) data.config = JSON.stringify(body.config || {});
    if (body.trigger !== undefined) {
      if (!TRIGGERS.includes(body.trigger)) throw fail("Unknown trigger");
      data.trigger = body.trigger;
    }
    if (body.action !== undefined) {
      if (!ACTIONS.includes(body.action)) throw fail("Unknown action");
      data.action = body.action;
    }
    if (!Object.keys(data).length) throw fail("Nothing to update");
    await db.automationRule.updateMany({ where: { id: params.ruleId, workspaceId: params.id }, data });
    return json(res, { ok: true });
  });

  router.delete("/api/workspaces/:id/rules/:ruleId", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id);
    requireOwner(ctx);
    await db.automationRule.deleteMany({ where: { id: params.ruleId, workspaceId: params.id } });
    return json(res, { ok: true });
  });
}

function shapeHook(h, stat) {
  return {
    id: h.id,
    workspaceId: h.workspaceId,
    url: h.url,
    events: h.events,
    enabled: h.enabled,
    createdAt: Number(h.createdAt),
    stats: stat || { pending: 0, delivered: 0, failed: 0 },
  };
}

function shapeDelivery(d) {
  return {
    id: d.id,
    webhookId: d.webhookId,
    event: d.event,
    status: d.status,
    attempts: d.attempts,
    lastStatus: d.lastStatus,
    lastError: d.lastError,
    nextAttemptAt: Number(d.nextAttemptAt),
    createdAt: Number(d.createdAt),
    deliveredAt: Number(d.deliveredAt),
  };
}

function shapeJob(j) {
  return {
    id: j.id,
    kind: j.kind,
    intervalMs: j.intervalMs,
    enabled: j.enabled,
    lastRunAt: Number(j.lastRunAt),
    nextRunAt: Number(j.nextRunAt),
    lastError: j.lastError,
  };
}

function shapeRule(r) {
  let config = {};
  try {
    config = JSON.parse(r.config || "{}");
  } catch {
    config = {};
  }
  return {
    id: r.id,
    name: r.name,
    trigger: r.trigger,
    action: r.action,
    config,
    enabled: r.enabled,
    createdAt: Number(r.createdAt),
  };
}
