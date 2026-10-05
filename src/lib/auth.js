import { cookies } from "next/headers";
import crypto from "crypto";
import { db } from "./db";

export const SESSION_COOKIE = "iw_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(":");
    if (!salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return (
      candidate.length === expected.length &&
      crypto.timingSafeEqual(candidate, expected)
    );
  } catch {
    return false;
  }
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

export async function createSession(userId) {
  const token = newSessionToken();
  const now = Date.now();
  await db.session.create({
    data: {
      id: token,
      userId,
      expiresAt: BigInt(now + SESSION_TTL_MS),
      createdAt: BigInt(now),
    },
  });
  return token;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

// Returns { user, session } or null. Identity is ALWAYS derived from the
// session cookie — never from anything the client sends in the body.
export async function getAuthUser(req) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getAuthUserByToken(token);
}

export async function getAuthUserByToken(token) {
  if (!token || token.length < 16) return null;
  const session = await db.session.findUnique({ where: { id: token } });
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await db.session.delete({ where: { id: token } }).catch(() => {});
    return null;
  }
  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user) return null;
  return { user, session };
}

export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, color: user.color };
}

// Role of a user inside a workspace: 'owner' | 'editor' | 'viewer' | null
export async function getRole(workspaceId, userId) {
  const m = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  return m ? m.role : null;
}

export function canEdit(role) {
  return role === "owner" || role === "editor";
}

export const USER_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#8b5cf6",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#14b8a6",
  "#a855f7",
];

// Prefer the least-used palette colors so collaborators are visually distinct
// (a pure random pick regularly gave two people in one room the same color).
export function pickColor(usage = {}) {
  const min = Math.min(...USER_COLORS.map((c) => usage[c] || 0));
  const pool = USER_COLORS.filter((c) => (usage[c] || 0) === min);
  return pool[Math.floor(Math.random() * pool.length)];
}
