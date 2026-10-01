import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAuthUser, publicUser, SESSION_COOKIE } from "@/lib/auth";

// GET → current session user (or null)
export async function GET() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ user: null });
  return NextResponse.json({ user: publicUser(auth.user) });
}

// DELETE → logout (destroy session + clear cookie)
export async function DELETE() {
  const auth = await getAuthUser();
  if (auth) {
    await db.session.deleteMany({ where: { id: auth.session.id } });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
