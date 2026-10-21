// Shared same-origin REST helper. Cookie-authenticated, throws on error.
// New code should use this instead of hand-rolled fetch blocks.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api(path, options = {}) {
  const { body, headers, raw, ...rest } = options;
  const init = {
    headers: { ...(raw ? {} : { "content-type": "application/json" }), ...headers },
    ...rest,
  };
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
  }
  const res = await fetch(path.startsWith("/") ? path : `/api${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export const get = (path, options) => api(path, { ...options, method: "GET" });
export const post = (path, body, options) => api(path, { ...options, method: "POST", body });
export const patch = (path, body, options) => api(path, { ...options, method: "PATCH", body });
export const del = (path, options) => api(path, { ...options, method: "DELETE" });
