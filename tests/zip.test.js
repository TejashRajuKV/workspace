import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createZip, crc32, readZip as parseZip } from "../server/lib/zip.js";

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, "end of central directory present");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50, "central header signature");
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const csize = buf.readUInt32LE(offset + 20);
    const usize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    assert.equal(data.length, usize, `size matches for ${name}`);
    assert.equal(crc32(data), crc, `crc matches for ${name}`);
    entries.set(name, data.toString("utf8"));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test("zip contains files and folders with verified checksums", () => {
  const zip = createZip([
    { name: "src/main.js", content: "console.log('hi');\n" },
    { name: "src/lib/helper.js", content: "export const x = 1;\n" },
    { name: "README.md", content: "# Hello\n" },
    { name: "empty.txt", content: "" },
  ]);
  const entries = readZip(zip);
  assert.equal(entries.get("src/main.js"), "console.log('hi');\n");
  assert.equal(entries.get("src/lib/helper.js"), "export const x = 1;\n");
  assert.equal(entries.get("README.md"), "# Hello\n");
  assert.equal(entries.get("empty.txt"), "");
  assert.ok(entries.has("src/"), "parent folder entry");
  assert.ok(entries.has("src/lib/"), "nested folder entry");
});

test("zip keeps unicode names and normalizes separators", () => {
  const zip = createZip([{ name: "docs\\héllo wörld.txt", content: "ok" }]);
  const entries = readZip(zip);
  assert.equal(entries.get("docs/héllo wörld.txt"), "ok");
});

test("zip skips traversal segments", () => {
  const zip = createZip([{ name: "../../etc/passwd", content: "no" }]);
  const entries = readZip(zip);
  assert.equal(entries.has("../../etc/passwd"), false);
  assert.equal(entries.get("etc/passwd"), "no");
});

test("zip is readable by Expand-Archive compatible structure", () => {
  const zip = createZip([{ name: "a.txt", content: "a" }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(6) & 0x0800, 0x0800, "UTF-8 flag set");
});

test("readZip round-trips written archives", () => {
  const zip = createZip([
    { name: "src/main.js", content: "console.log(1);\n" },
    { name: "src/lib/util.js", content: "export const a = 2;\n" },
    { name: "", content: "" },
  ]);
  const parsed = parseZip(zip);
  assert.deepEqual(
    parsed.files.map((f) => f.path),
    ["src/main.js", "src/lib/util.js"]
  );
  assert.equal(parsed.files[0].content, "console.log(1);\n");
  assert.equal(parsed.files[1].size, Buffer.byteLength("export const a = 2;\n"));
  assert.equal(parsed.skipped.length, 0);
});

test("readZip strips traversal paths", () => {
  const zip = createZip([{ name: "../../etc/passwd", content: "no" }]);
  const parsed = parseZip(zip);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].path, "etc/passwd");
});

test("readZip rejects binary entries with a reason", () => {
  const zip = createZip([{ name: "bin.dat", content: "abc\u0000def" }]);
  const parsed = parseZip(zip);
  assert.equal(parsed.files.length, 0);
  assert.equal(parsed.skipped[0].reason, "binary files are not supported");
});

test("readZip enforces per-file and archive size limits", () => {
  const big = "x".repeat(600 * 1024);
  const zip = createZip([
    { name: "big.txt", content: big },
    { name: "small.txt", content: "ok" },
  ]);
  const perFile = parseZip(zip, { maxFileBytes: 512 * 1024 });
  assert.deepEqual(
    perFile.files.map((f) => f.path),
    ["small.txt"]
  );
  assert.equal(perFile.skipped.find((s) => s.path === "big.txt").reason, "file too large");

  assert.throws(() => parseZip(zip, { maxTotalBytes: 1024, maxFileBytes: 1024 * 1024 }), /too large/i);
});

test("readZip rejects non-zip buffers", () => {
  assert.throws(() => parseZip(Buffer.from("not a zip file")), /not a zip/i);
  assert.throws(() => parseZip(Buffer.alloc(0)), /not a zip/i);
});
