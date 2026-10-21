import zlib from "node:zlib";

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(value) {
  const d = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function normalizeName(name) {
  const parts = String(name || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..");
  return parts.join("/");
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

export function readZip(buf, limits = {}) {
  const maxFiles = limits.maxFiles ?? 2000;
  const maxFileBytes = limits.maxFileBytes ?? 512 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 25 * 1024 * 1024;
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("Not a ZIP archive");
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("Not a ZIP archive");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > maxFiles) throw new Error(`Too many files (max ${maxFiles})`);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = [];
  const skipped = [];
  let total = 0;

  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length) throw new Error("Corrupt ZIP archive");
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("Corrupt ZIP archive");
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const csize = buf.readUInt32LE(offset + 20);
    const usize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const rawName = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) {
      skipped.push({ path: rawName, reason: "encrypted" });
      continue;
    }
    if (method !== 0 && method !== 8) {
      skipped.push({ path: rawName, reason: "unsupported compression" });
      continue;
    }
    if (csize === 0xffffffff || usize === 0xffffffff) {
      skipped.push({ path: rawName, reason: "ZIP64 is not supported" });
      continue;
    }
    if (rawName.endsWith("/")) continue;

    const name = normalizeName(rawName);
    if (!name) {
      skipped.push({ path: rawName, reason: "invalid path" });
      continue;
    }
    if (usize > maxFileBytes) {
      skipped.push({ path: name, reason: "file too large" });
      continue;
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      skipped.push({ path: name, reason: "corrupt entry" });
      continue;
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + csize > buf.length) {
      skipped.push({ path: name, reason: "corrupt entry" });
      continue;
    }
    let data;
    try {
      const packed = buf.subarray(dataStart, dataStart + csize);
      data = method === 8 ? zlib.inflateRawSync(packed) : packed;
    } catch {
      skipped.push({ path: name, reason: "could not decompress" });
      continue;
    }
    if (data.length !== usize || crc32(data) !== crc) {
      skipped.push({ path: name, reason: "checksum mismatch" });
      continue;
    }
    total += data.length;
    if (total > maxTotalBytes) throw new Error(`Archive too large (max ${maxTotalBytes} bytes)`);
    if (data.includes(0)) {
      skipped.push({ path: name, reason: "binary files are not supported" });
      continue;
    }
    files.push({ path: name, content: data.toString("utf8"), size: data.length });
  }

  return { files, skipped };
}

export function createZip(entries) {
  const names = new Set();
  const records = [];
  const addRecord = (name, data, mtime, isDir) => {
    if (!name || names.has(name)) return;
    names.add(name);
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(data ?? "", "utf8");
    const deflated = raw.length ? zlib.deflateRawSync(raw, { level: 9 }) : Buffer.alloc(0);
    const useDeflate = raw.length > 0 && deflated.length < raw.length;
    const stored = useDeflate ? deflated : raw;
    records.push({
      name,
      isDir,
      data: stored,
      size: raw.length,
      crc: crc32(raw),
      method: useDeflate ? 8 : 0,
      ...dosStamp(mtime),
    });
  };

  for (const entry of entries || []) {
    const name = normalizeName(entry?.name);
    if (!name) continue;
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      addRecord(parts.slice(0, i).join("/") + "/", "", entry?.mtime, true);
    }
    addRecord(name, entry?.content, entry?.mtime, false);
  }

  const chunks = [];
  let offset = 0;
  for (const rec of records) {
    const nameBuf = Buffer.from(rec.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(rec.method, 8);
    local.writeUInt16LE(rec.time, 10);
    local.writeUInt16LE(rec.date, 12);
    local.writeUInt32LE(rec.crc, 14);
    local.writeUInt32LE(rec.data.length, 18);
    local.writeUInt32LE(rec.size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    rec.offset = offset;
    chunks.push(local, nameBuf, rec.data);
    offset += local.length + nameBuf.length + rec.data.length;
    if (offset > 0xffffffff) throw new Error("Archive too large");
  }

  const centralOffset = offset;
  const centrals = [];
  for (const rec of records) {
    const nameBuf = Buffer.from(rec.name, "utf8");
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(rec.method, 10);
    central.writeUInt16LE(rec.time, 12);
    central.writeUInt16LE(rec.date, 14);
    central.writeUInt32LE(rec.crc, 16);
    central.writeUInt32LE(rec.data.length, 20);
    central.writeUInt32LE(rec.size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((rec.isDir ? ((0o040755 << 16) | 0x10) : 0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(rec.offset, 42);
    centrals.push(central, nameBuf);
    offset += central.length + nameBuf.length;
  }

  if (records.length > 0xffff) throw new Error("Too many files for a ZIP archive");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(offset - centralOffset, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...centrals, eocd]);
}
