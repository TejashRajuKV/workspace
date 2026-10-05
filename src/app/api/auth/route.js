import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  hashPassword,
  verifyPassword,
  createSession,
  sessionCookieOptions,
  publicUser,
  pickColor,
  SESSION_COOKIE,
} from "@/lib/auth";
import { fail } from "@/lib/apiHelpers";

// POST /api/auth  { mode: "register" | "login", username, password }
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON");
  }

  const mode = body.mode === "register" ? "register" : "login";
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!/^[a-z0-9_\-\.]{3,24}$/.test(username))
    return fail("Username must be 3-24 chars: letters, digits, _ - . only");
  if (password.length < 6 || password.length > 128)
    return fail("Password must be 6-128 characters");

  if (mode === "register") {
    const existing = await db.user.findUnique({ where: { username } });
    if (existing) return fail("Username already taken", 409);
    const user = await db.user.create({
      data: {
        username,
        passwordHash: hashPassword(password),
        color: pickColor(await colorUsage()),
        createdAt: BigInt(Date.now()),
      },
    });
    const token = await createSession(user.id);
    const res = NextResponse.json({ user: publicUser(user) });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  }

  // login
  const user = await db.user.findUnique({ where: { username } });
  if (!user || !verifyPassword(password, user.passwordHash))
    return fail("Invalid username or password", 401);
  const token = await createSession(user.id);
  const res = NextResponse.json({ user: publicUser(user) });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}

async function colorUsage() {
  const rows = await db.user.groupBy({ by: ["color"], _count: { color: true } });
  return Object.fromEntries(rows.map((r) => [r.color, r._count.color]));
}
