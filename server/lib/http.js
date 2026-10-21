// Minimal HTTP helpers for the Node server — JSON response, cookie and body
// plumbing that replaces the framework response helpers used before.

import { Buffer } from "node:buffer";

// Documents can be 512KB, JSON envelopes a bit larger; cap hard so a malicious
// client cannot exhaust memory.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

// Throwaway equivalent of the old `fail()` helper — always used with throw so a
// handler can bail out without threading a response object through every call.
export function fail(message, status = 400) {
  return new HttpError(status, message);
}

// BigInt columns (epoch ms) are stored as 64-bit integers; the previous
// framework serializer encoded them as {"$bigint":"<decimal>"}. Keep that
// contract so no response can ever throw on a raw Prisma row.
const BIGINT_KEY = "$bigint";
const replacer = (_key, value) =>
  typeof value === "bigint" ? { [BIGINT_KEY]: value.toString() } : value;

export function json(res, data, status = 200) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data === undefined ? null : data, replacer);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

// Parse `Set-Cookie` values off the response headers set so far and append one.
export function appendCookie(res, value) {
  const prev = res.getHeader("set-cookie");
  const list = prev == null ? [] : Array.isArray(prev) ? prev.slice() : [String(prev)];
  list.push(value);
  res.setHeader("set-cookie", list);
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new HttpError(413, "Payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function readRaw(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new HttpError(413, "Payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function sendError(res, err) {
  const status = Number(err?.status) >= 400 && Number(err?.status) < 600 ? Number(err.status) : 500;
  if (status >= 500) console.error("[api]", err);
  json(res, { error: err?.message || "Internal server error" }, status);
}