// Persistent notifications: store a row, then push it to the user's socket room.
import { db } from "./db.js";
import { serviceClient } from "./serviceClient.js";

const MAX_TITLE = 160;
const MAX_BODY = 500;

function shape(row) {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    type: row.type,
    title: row.title,
    body: row.body,
    linkType: row.linkType,
    linkId: row.linkId,
    actorId: row.actorId,
    readAt: Number(row.readAt),
    createdAt: Number(row.createdAt),
  };
}

export async function createNotification({
  userId,
  workspaceId = "",
  type = "system",
  title,
  body = "",
  linkType = "",
  linkId = "",
  actorId = "",
}) {
  if (!userId || !title) return null;
  const row = await db.notification.create({
    data: {
      userId,
      workspaceId,
      type: String(type).slice(0, 32),
      title: String(title).slice(0, MAX_TITLE),
      body: String(body).slice(0, MAX_BODY),
      linkType: String(linkType).slice(0, 32),
      linkId: String(linkId).slice(0, 64),
      actorId,
      createdAt: BigInt(Date.now()),
    },
  });
  const shaped = shape(row);
  serviceClient.notifyUser(userId, shaped).catch(() => {});
  return shaped;
}

// Resolve usernames → user ids (used for @mentions).
export async function userIdsForUsernames(usernames) {
  const list = [...new Set((usernames || []).map((u) => String(u).toLowerCase()))].filter(Boolean);
  if (!list.length) return new Map();
  const users = await db.user.findMany({ where: { username: { in: list } } });
  return new Map(users.map((u) => [u.username, u.id]));
}

export function extractMentions(text) {
  const out = new Set();
  const re = /@([a-z0-9_.-]{3,24})/gi;
  let m;
  while ((m = re.exec(String(text || "")))) out.add(m[1].toLowerCase());
  return [...out];
}

export { shape as shapeNotification };

// Fan out a board comment (posted via the collab service) into notifications:
// reply → original thread author; @mentions → each mentioned user.
export async function notifyCommentCreated({ workspaceId, actorId, payload }) {
  const objectId = payload?.objectId;
  if (!workspaceId || !objectId) return;
  const body = String(payload?.body || "");
  const actor = actorId ? await db.user.findUnique({ where: { id: actorId } }) : null;
  const actorName = actor?.username || "someone";
  const ws = await db.workspace.findUnique({ where: { id: workspaceId } });
  const wsName = ws?.name || "workspace";

  const mentioned = await userIdsForUsernames(extractMentions(body));
  const mentionIds = new Set([...mentioned.values()].filter(Boolean));
  const targets = new Map(); // userId → type
  const threadAuthorId = payload?.threadAuthorId || "";
  if (threadAuthorId && threadAuthorId !== actorId) targets.set(threadAuthorId, "reply");
  for (const id of mentionIds) if (id !== actorId) targets.set(id, "mention");

  await Promise.all(
    [...targets].map(([userId, type]) =>
      createNotification({
        userId,
        workspaceId,
        type,
        title: `${actorName} ${type === "mention" ? "mentioned you" : "replied"} in ${wsName}`,
        body: body.slice(0, MAX_BODY),
        linkType: "object",
        linkId: objectId,
        actorId: actorId || "",
      })
    )
  );
}
