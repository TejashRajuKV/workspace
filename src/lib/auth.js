import { cookies } from "next/headers";
import { getCookieValue } from "./sessionCookie.js";
import { getAuthUserByToken, SESSION_COOKIE } from "./authCore.js";

export * from "./authCore.js";

// Next.js adapter. Node/Express code should use authCore.js directly.
export async function getAuthUser(req) {
  if (req?.headers) {
    const header = typeof req.headers.get === "function"
      ? req.headers.get("cookie")
      : req.headers.cookie;
    const token = getCookieValue(header, SESSION_COOKIE);
    return token ? getAuthUserByToken(token) : null;
  }
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  return token ? getAuthUserByToken(token) : null;
}
