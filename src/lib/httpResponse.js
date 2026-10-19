// Framework-neutral HTTP response and cookie helpers shared by Next.js and Express adapters.

export function jsonResult(body, status = 200, headers = {}) {
  return { status, body, headers: { "content-type": "application/json; charset=utf-8", ...headers } };
}

function cookieValue(value) {
  return encodeURIComponent(String(value));
}

export function serializeCookie(name, value, options = {}) {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new TypeError("Invalid cookie name");
  }
  const parts = [`${name}=${cookieValue(value)}`];
  if (options.maxAge != null) {
    if (!Number.isFinite(options.maxAge)) throw new TypeError("Invalid cookie maxAge");
    parts.push(`Max-Age=${Math.trunc(options.maxAge)}`);
  }
  parts.push(`Path=${options.path || "/"}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) {
    const sameSite = String(options.sameSite).toLowerCase();
    const normalized = { lax: "Lax", strict: "Strict", none: "None" }[sameSite];
    if (!normalized) throw new TypeError("Invalid cookie sameSite value");
    parts.push(`SameSite=${normalized}`);
  }
  return parts.join("; ");
}

export function clearCookie(name, options = {}) {
  return serializeCookie(name, "", { ...options, maxAge: 0 });
}

export function sendJsonResult(res, result) {
  res.status(result.status);
  for (const [name, value] of Object.entries(result.headers || {})) res.set(name, value);
  return res.json(result.body);
}
