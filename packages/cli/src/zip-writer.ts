import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
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
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Forward-slash path inside the archive. */
  path: string;
  data: Uint8Array;
}

/**
 * Write a .zip (deflate, no encryption, no zip64) with a fixed timestamp, so packing the same
 * files twice gives the same bytes. Files must be under 4 GB; plugin packages are far smaller.
 */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (chunk: Uint8Array): void => {
    chunks.push(chunk);
    offset += chunk.byteLength;
  };
  const encoder = new TextEncoder();
  const DOS_TIME = 0;
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const body = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 8, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.byteLength, true);
    local.setUint32(22, entry.data.byteLength, true);
    local.setUint16(26, name.byteLength, true);
    const localOffset = offset;
    push(new Uint8Array(local.buffer));
    push(name);
    push(body);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 0x031e, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 8, true);
    header.setUint16(12, DOS_TIME, true);
    header.setUint16(14, dosDate, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, body.byteLength, true);
    header.setUint32(24, entry.data.byteLength, true);
    header.setUint16(28, name.byteLength, true);
    header.setUint32(38, (0o100644 << 16) >>> 0, true);
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
