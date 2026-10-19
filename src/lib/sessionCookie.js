// Framework-neutral cookie parsing shared by Next.js and Express adapters.
// Cookie values are decoded defensively and malformed values are ignored.
export function getCookieValue(cookieHeader, name) {
  if (typeof cookieHeader !== "string" || !name) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}
