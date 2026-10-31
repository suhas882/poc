// @ts-check
import zlib from 'node:zlib';

/**
 * Minimal, defensive ZIP reader for DOCX/XLSX. Supports stored and deflate
 * entries, refuses encrypted entries, and caps entry count and total
 * uncompressed size to stop zip bombs.
 */
export function readZip(buf, { maxEntries = 2000, maxTotalBytes = 200 * 1024 * 1024 } = {}) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a ZIP archive.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw new Error('The archive has too many entries.');
  /** @type {Map<string, {method: number, compressed: number, size: number, offset: number, flags: number}>} */
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { method, compressed, size, offset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  let total = 0;
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    /** @param {string} name @returns {Buffer | null} */
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.flags & 0x1) throw new Error('Encrypted documents are not supported.');
      total += e.size;
      if (total > maxTotalBytes) throw new Error('The document expands to more data than allowed.');
      const lh = e.offset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('Corrupt ZIP entry.');
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.subarray(start, start + e.compressed);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: Math.max(e.size, 1) + 1024 });
      throw new Error(`Unsupported compression method ${e.method}.`);
    }
  };
}

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decodeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()]);
