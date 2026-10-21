// End-to-end REST smoke test against a running server (default :3000).
//   node scripts/smoke.js
// Exercises every endpoint the SPA uses, including error paths.

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:3000";
const suffix = Date.now().toString(36).slice(-6);

let failures = 0;
const jar = new Map();

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeCookies(res) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (/max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(jar.size ? { cookie: cookieHeader() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  storeCookies(res);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

function check(label, cond, extra) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${extra ? ` → ${JSON.stringify(extra).slice(0, 300)}` : ""}`);
  }
}

console.log(`smoke: ${BASE}\n`);

// ---- health -----------------------------------------------------------------
{
  const r = await call("GET", "/api/health");
  check("GET /api/health → 200", r.status === 200, r.data);
  check("health reports node runtime", /^node \d/.test(r.data?.runtime || ""), r.data);
}

// ---- auth -------------------------------------------------------------------
{
  const r = await call("POST", "/api/auth", { mode: "register", username: `smoke_${suffix}`, password: "secret123" });
  check("POST /api/auth register → 200", r.status === 200, r.data);
  check("register returns a user", !!r.data?.user?.id, r.data);
  check("session cookie set httpOnly", /HttpOnly/i.test(r.headers.getSetCookie?.().join("|") || ""), r.headers.getSetCookie?.());

  const bad = await call("POST", "/api/auth", { mode: "register", username: "x", password: "secret123" });
  check("short username rejected (400)", bad.status === 400, bad.data);

  const dupe = await call("POST", "/api/auth", { mode: "register", username: `smoke_${suffix}`, password: "secret123" });
  check("duplicate username rejected (409)", dupe.status === 409, dupe.data);

  const wrong = await call("POST", "/api/auth", { mode: "login", username: `smoke_${suffix}`, password: "wrongpassword" });
  check("bad password rejected (401)", wrong.status === 401, wrong.data);

  const login = await call("POST", "/api/auth", { mode: "login", username: `smoke_${suffix}`, password: "secret123" });
  check("login → 200", login.status === 200, login.data);

  const me = await call("GET", "/api/auth/session");
  check("GET /api/auth/session → user", me.data?.user?.username === `smoke_${suffix}`, me.data);
}

// ---- workspaces -------------------------------------------------------------
let workspaceId = null;
{
  const list = await call("GET", "/api/workspaces");
  check("GET /api/workspaces → 200", list.status === 200, list.data);
  check("list is an array", Array.isArray(list.data?.workspaces), list.data);

  const created = await call("POST", "/api/workspaces", { name: "Smoke workspace", description: "e2e" });
  check("POST /api/workspaces → 201", created.status === 201, created.data);
  check("creator is owner", created.data?.workspace?.role === "owner", created.data);
  workspaceId = created.data?.workspace?.id;

  const noName = await call("POST", "/api/workspaces", { name: "   " });
  check("empty name rejected (400)", noName.status === 400, noName.data);

  const meta = await call("GET", `/api/workspaces/${workspaceId}`);
  check("GET /api/workspaces/:id → 200", meta.status === 200, meta.data);
  check("meta has owner role", meta.data?.role === "owner", meta.data);
  check("meta lists members", meta.data?.members?.length === 1, meta.data);

  const patched = await call("PATCH", `/api/workspaces/${workspaceId}`, { description: "updated" });
  check("PATCH workspace → 200", patched.status === 200, patched.data);

  const missing = await call("GET", "/api/workspaces/does-not-exist");
  check("unknown workspace → 404", missing.status === 404, missing.data);

  const join = await call("POST", `/api/workspaces/${workspaceId}/join`);
  check("re-join is idempotent 200 + owner", join.status === 200 && join.data?.role === "owner", join.data);
}

// ---- virtual file system ----------------------------------------------------
let fileId = null;
{
  const created = await call("POST", `/api/workspaces/${workspaceId}/files`, {
    path: "src/lib/hello.js",
    content: "console.log('hi');",
  });
  check("POST nested file → 201", created.status === 201, created.data);
  fileId = created.data?.doc?.id;

  const folder = await call("POST", `/api/workspaces/${workspaceId}/files`, { path: "notes/", isFolder: true });
  check("POST folder (trailing slash) → 201", folder.status === 201, folder.data);

  const dupe = await call("POST", `/api/workspaces/${workspaceId}/files`, { path: "src/lib/hello.js" });
  check("duplicate path rejected (409)", dupe.status === 409, dupe.data);

  const traversal = await call("POST", `/api/workspaces/${workspaceId}/files`, { path: "../escape.js" });
  check("path traversal rejected (400)", traversal.status === 400, traversal.data);

  const renamed = await call("PATCH", `/api/workspaces/${workspaceId}/files/${fileId}`, { path: "src/deep/moved.js" });
  check("PATCH rename creates parents → 200", renamed.status === 200, renamed.data);

  const boot = await call("GET", `/api/workspaces/${workspaceId}/bootstrap`);
  check("bootstrap → 200", boot.status === 200, boot.data);
  check("bootstrap carries docs", Array.isArray(boot.data?.docs) && boot.data.docs.length >= 3, boot.data?.docs?.length);
  check("bootstrap creates src/ + deep/", boot.data?.docs?.some((d) => d.path === "src/") && boot.data?.docs?.some((d) => d.path === "src/deep/"), boot.data?.docs?.map((d) => d.path));
  check("bootstrap returns me", !!boot.data?.me?.id, boot.data?.me);

  const versions = await call("GET", `/api/workspaces/${workspaceId}/versions?limit=5`);
  check("versions → 200", versions.status === 200, versions.data);
  check("operations is an array", Array.isArray(versions.data?.operations), versions.data);

  const del = await call("DELETE", `/api/workspaces/${workspaceId}/files/${fileId}`);
  check("DELETE file → 200", del.status === 200, del.data);

  const gone = await call("GET", `/api/workspaces/${workspaceId}/bootstrap`);
  check("deleted file gone from bootstrap", !gone.data?.docs?.some((d) => d.id === fileId), gone.data?.docs?.map((d) => d.path));

  const restore = await call("POST", `/api/workspaces/${workspaceId}/restore`, { version: 1 });
  check("restore without a live version is handled", restore.status === 502 || restore.status === 200 || restore.status === 400, restore.data);
}

// ---- logout -----------------------------------------------------------------
{
  const out = await call("DELETE", "/api/auth/session");
  check("logout → 200", out.status === 200, out.data);
  const me = await call("GET", "/api/auth/session");
  check("session cleared", me.data?.user === null, me.data);

  const denied = await call("GET", "/api/workspaces");
  check("anonymous workspaces → 401", denied.status === 401, denied.data);
}

// ---- static / routing -------------------------------------------------------
{
  const shell = await fetch(BASE + "/?w=abc", { headers: { accept: "text/html" } });
  check("GET / serves the SPA shell", shell.status === 200, shell.status);
  const html = await shell.text();
  check("shell mounts #root", html.includes('id="root"'), html.slice(0, 120));
}

console.log(`\n${failures === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);