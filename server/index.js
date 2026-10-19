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
