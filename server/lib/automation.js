// AI-free automation: webhook fan-out (HMAC-signed, retried), scheduled
// export jobs, and simple trigger→action rules. Runs inside the web process.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { createZip } from "./zip.js";
import { openSecret } from "./secrets.js";
import { createNotification } from "./notifications.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const BACKUP_DIR = path.join(ROOT, "uploads", "backups");
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;

function sign(secret, timestamp, body) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function matchesEvents(events, event) {
  const list = String(events || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (!list.length) return false;
  return list.includes("*") || list.includes(event);
}

// Fire an automation event: run matching rules, enqueue webhook deliveries.
export async function dispatchEvent({ workspaceId, event, payload = {}, actorId = "" }) {
  if (!workspaceId || !event) return;
  try {
    const [webhooks, rules] = await Promise.all([
      db.webhook.findMany({ where: { workspaceId, enabled: true } }),
      db.automationRule.findMany({ where: { workspaceId, enabled: true } }),
    ]);
    const now = BigInt(Date.now());
    const body = JSON.stringify({ event, workspaceId, actorId, at: Number(now), payload });

    for (const hook of webhooks) {
      if (!matchesEvents(hook.events, event)) continue;
      await db.webhookDelivery.create({
        data: {
          webhookId: hook.id,
          workspaceId,
          event,
          payload: body,
          status: "pending",
          nextAttemptAt: now,
          createdAt: now,
        },
      });
    }

    for (const rule of rules) {
      if (rule.trigger !== event && rule.trigger !== "*") continue;
      if (rule.action === "notify") {
        const meta = safeJson(rule.config);
        let targets = Array.isArray(meta.userIds) ? meta.userIds : [];
        if (!targets.length) {
          const ws = await db.workspace.findUnique({ where: { id: workspaceId } });
          if (ws?.ownerId) targets = [ws.ownerId];
        }
        for (const userId of targets) {
          await createNotification({
            userId,
            workspaceId,
            type: "system",
            title: rule.name || `Automation: ${event}`,
            body: meta.body || body.slice(0, 240),
            linkType: "workspace",
            linkId: workspaceId,
            actorId,
          });
        }
      }
    }
  } catch (err) {
    console.error("[automation] dispatch failed:", err.message);
  }
}

function safeJson(str) {
  try {
    return JSON.parse(str || "{}");
  } catch {
    return {};
  }
}

async function deliverOnce(delivery, hook) {
  const secret = openSecret(hook.secret) || "";
  const timestamp = String(Date.now());
  const signature = sign(secret, timestamp, delivery.payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-iw-event": delivery.event,
        "x-iw-delivery": String(delivery.id),
        "x-iw-timestamp": timestamp,
        "x-iw-signature": `sha256=${signature}`,
      },
      body: delivery.payload,
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function drainDeliveries() {
  const now = BigInt(Date.now());
  const due = await db.webhookDelivery.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now } },
    orderBy: { id: "asc" },
    take: 25,
  });
  for (const delivery of due) {
    const hook = await db.webhook.findUnique({ where: { id: delivery.webhookId } });
    if (!hook || !hook.enabled) {
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: "failed", lastError: "webhook removed" },
      });
      continue;
    }
    const result = await deliverOnce(delivery, hook);
    const attempts = delivery.attempts + 1;
    if (result.ok) {
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: "delivered", attempts, lastStatus: result.status, deliveredAt: BigInt(Date.now()) },
      });
    } else if (attempts >= MAX_ATTEMPTS) {
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: "failed", attempts, lastStatus: result.status, lastError: result.error || `HTTP ${result.status}` },
      });
    } else {
      const backoff = RETRY_BASE_MS * 2 ** (attempts - 1);
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts,
          lastStatus: result.status,
          lastError: result.error || `HTTP ${result.status}`,
          nextAttemptAt: BigInt(Date.now() + backoff),
        },
      });
    }
  }
}

async function runExportJob(job) {
  const docs = await db.document.findMany({
    where: { workspaceId: job.workspaceId, deleted: false, isFolder: false },
  });
  const entries = docs.map((d) => ({ name: d.path, content: d.content, mtime: new Date(Number(d.updatedAt)) }));
  const buffer = createZip(entries);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(BACKUP_DIR, `${job.workspaceId}-${stamp}.zip`);
  fs.writeFileSync(target, buffer);
  return target;
}

async function drainSchedules() {
  const now = BigInt(Date.now());
  const due = await db.scheduledJob.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    orderBy: { id: "asc" },
    take: 10,
  });
  for (const job of due) {
    let lastError = "";
    try {
      if (job.kind === "export") await runExportJob(job);
    } catch (err) {
      lastError = String(err?.message || err);
    }
    await db.scheduledJob.update({
      where: { id: job.id },
      data: {
        lastRunAt: BigInt(Date.now()),
        nextRunAt: BigInt(Date.now() + job.intervalMs),
        lastError,
      },
    });
  }
}

let started = false;
export function startAutomationWorker() {
  if (started) return;
  started = true;
  setInterval(() => {
    drainDeliveries().catch((err) => console.error("[automation] deliveries:", err.message));
  }, 15_000);
  setInterval(() => {
    drainSchedules().catch((err) => console.error("[automation] schedules:", err.message));
  }, 60_000);
}

export { BACKUP_DIR };
