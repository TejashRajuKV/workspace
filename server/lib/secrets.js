import crypto from "node:crypto";

const KEY = crypto
  .createHash("sha256")
  .update(`${process.env.GITHUB_TOKEN_KEY || process.env.INTERNAL_TOKEN || "infinite-workspace"}:github-token:v1`)
  .digest();

export function sealToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
  return {
    tokenCipher: encrypted.toString("base64"),
    tokenIv: iv.toString("base64"),
    tokenTag: cipher.getAuthTag().toString("base64"),
  };
}

export function openToken(record) {
  if (!record?.tokenCipher || !record?.tokenIv || !record?.tokenTag) return null;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      KEY,
      Buffer.from(record.tokenIv, "base64")
    );
    decipher.setAuthTag(Buffer.from(record.tokenTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.tokenCipher, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

// Generic single-string secret sealing (webhook signing secrets).
export function sealSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    c: enc.toString("base64"),
    i: iv.toString("base64"),
    t: cipher.getAuthTag().toString("base64"),
  });
}

export function openSecret(sealed) {
  try {
    const { c, i, t } = JSON.parse(sealed);
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(i, "base64"));
    decipher.setAuthTag(Buffer.from(t, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(c, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function randomSecret() {
  return crypto.randomBytes(24).toString("hex");
}
