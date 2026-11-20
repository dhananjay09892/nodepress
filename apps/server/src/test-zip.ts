import { deflateRawSync } from 'node:zlib';

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface TestZipEntry {
  name: string;
  data: string | Uint8Array;
  /** Default true (deflate); false stores the bytes. */
  deflate?: boolean;
  /** Unix mode in the high 16 bits of the external attributes (for symlink tests). */
  mode?: number;
  encrypted?: boolean;
}

/** Builds a .zip in memory, for tests. */
export function createTestZip(entries: TestZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (chunk: Uint8Array): void => {
    chunks.push(chunk);
    offset += chunk.byteLength;
  };
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const raw = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data;
    const method = entry.deflate === false ? 0 : 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const flags = entry.encrypted ? 1 : 0;
    const crc = crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.byteLength, true);
    local.setUint32(22, raw.byteLength, true);
    local.setUint16(26, name.byteLength, true);
    const localOffset = offset;
    push(new Uint8Array(local.buffer));
    push(name);
    push(body);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 0x031e, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, flags, true);
    header.setUint16(10, method, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, body.byteLength, true);
    header.setUint32(24, raw.byteLength, true);
    header.setUint16(28, name.byteLength, true);
    header.setUint32(38, ((entry.mode ?? 0o100644) << 16) >>> 0, true);
    header.setUint32(42, localOffset, true);
    central.push(new Uint8Array(header.buffer), name);
  }
  const centralOffset = offset;
  for (const chunk of central) push(chunk);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, offset - centralOffset, true);
  end.setUint32(16, centralOffset, true);
  push(new Uint8Array(end.buffer));
  const out = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
