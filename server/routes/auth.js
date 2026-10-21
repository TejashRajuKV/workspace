// /api/auth — account creation, login, session lookup, logout.

import { db } from "../lib/db.js";
import {
  hashPassword,
  verifyPassword,
  createSession,
  sessionCookie,
  clearSessionCookie,
  publicUser,
  pickColor,
  getAuthUser,
} from "../lib/auth.js";
import { fail, json, readJson, appendCookie } from "../lib/http.js";

export function registerAuthRoutes(router) {
  // POST /api/auth  { mode: "register" | "login", username, password }
  router.post("/api/auth", async (req, res) => {
    const body = await readJson(req);

    const mode = body.mode === "register" ? "register" : "login";
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!/^[a-z0-9_.-]{3,24}$/.test(username))
      throw fail("Username must be 3-24 chars: letters, digits, _ - . only");
    if (password.length < 6 || password.length > 128)
      throw fail("Password must be 6-128 characters");

    if (mode === "register") {
      const existing = await db.user.findUnique({ where: { username } });
      if (existing) throw fail("Username already taken", 409);
      const user = await db.user.create({
        data: {
          username,
          passwordHash: hashPassword(password),
          color: pickColor(),
          createdAt: BigInt(Date.now()),
        },
      });
      const token = await createSession(user.id);
      appendCookie(res, sessionCookie(token));
      return json(res, { user: publicUser(user) });
    }

    // login
    const user = await db.user.findUnique({ where: { username } });
    if (!user || !verifyPassword(password, user.passwordHash))
      throw fail("Invalid username or password", 401);
    const token = await createSession(user.id);
    appendCookie(res, sessionCookie(token));
    return json(res, { user: publicUser(user) });
  });

  // GET → current session user (or null)
  router.get("/api/auth/session", async (req, res) => {
    const auth = await getAuthUser(req);
    if (!auth) return json(res, { user: null });
    return json(res, { user: publicUser(auth.user) });
  });

  // DELETE → logout (destroy session + clear cookie)
  router.delete("/api/auth/session", async (req, res) => {
    const auth = await getAuthUser(req);
    if (auth) {
      await db.session.deleteMany({ where: { id: auth.session.id } });
    }
    appendCookie(res, clearSessionCookie());
    return json(res, { ok: true });
  });
}