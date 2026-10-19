import { createServer } from "node:http";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3001);

export function createApiServer() {
  return createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const send = (status, body) => {
      const json = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-length": Buffer.byteLength(json),
      });
      res.end(json);
    };

    if (req.method === "GET" && pathname === "/healthz") {
      return send(200, { status: "ok" });
    }
    if (pathname.startsWith("/api/")) {
      return send(501, { error: "This API route has not been migrated from Next.js yet." });
    }
    return send(404, { error: "Not found" });
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
