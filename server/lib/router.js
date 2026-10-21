// Tiny path router: `/api/workspaces/:id/files/:fileId` → handler + params.
// Express-style patterns, zero dependencies, sync matching.

import { fail } from "./http.js";

function compile(pattern) {
  const segments = pattern.split("/").filter(Boolean);
  return segments.map((s) => (s.startsWith(":") ? { param: s.slice(1) } : { literal: s }));
}

function matchSegments(compiled, parts) {
  if (compiled.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < compiled.length; i++) {
    const seg = compiled[i];
    if (seg.literal !== undefined) {
      if (seg.literal !== parts[i]) return null;
    } else {
      let value;
      try {
        value = decodeURIComponent(parts[i]);
      } catch {
        value = parts[i];
      }
      if (value === "") return null;
      params[seg.param] = value;
    }
  }
  return params;
}

export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    routes.push({ method, compiled: compile(pattern), handler, pattern });
  };

  const router = {
    routes,
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    put: (p, h) => add("PUT", p, h),
    patch: (p, h) => add("PATCH", p, h),
    delete: (p, h) => add("DELETE", p, h),
    // Returns { handler, params } or null (no route / no path+method match).
    match(method, pathname) {
      const parts = pathname.split("/").filter(Boolean);
      let pathExists = false;
      for (const route of routes) {
        const params = matchSegments(route.compiled, parts);
        if (!params) continue;
        pathExists = true;
        if (route.method === method) return { handler: route.handler, params };
      }
      if (pathExists) throw fail("Method not allowed", 405);
      return null;
    },
  };

  return router;
}