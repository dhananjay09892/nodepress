import { inflateRawSync } from 'node:zlib';

/**
 * A small, strict .zip reader for uploaded plugin packages. It reads the central directory,
 * supports stored and deflated entries, and refuses anything risky: encryption, zip64, symbolic
 * links, absolute or `..` paths, backslashes, duplicate names, and archives that are too big or
 * inflate beyond the limits (zip bombs).
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipLimits {
  maxEntries: number;
  /** Largest single file, uncompressed. */
  maxFileBytes: number;
  /** All files together, uncompressed. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

export interface ZipFile {
  /** Forward-slash path inside the archive, no leading slash. */
  path: string;
  data: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Check an entry name; returns the cleaned path or throws. */
export function safeZipPath(name: string): string {
  if (name === '' || name.includes('\0') || name.includes('\\')) {
    throw new ZipError(`unsafe file name ${JSON.stringify(name)}`);
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new ZipError(`absolute path ${JSON.stringify(name)}`);
  }
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.includes('..')) {
    throw new ZipError(`unsafe path ${JSON.stringify(name)}`);
  }
  return parts.join('/');
}

/** Read the files of a zip archive (folders are left out). Throws `ZipError`. */
export function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipFile[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22) throw new ZipError('not a zip file');

  // The end-of-central-directory record is within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ZipError('not a zip file');
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('zip64 archives are not supported');
  }
  if (entryCount > limits.maxEntries) throw new ZipError('the archive has too many files');
  if (centralOffset + centralSize > eocd) throw new ZipError('the archive is damaged');

  const files: ZipFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let pos = centralOffset;
  for (let n = 0; n < entryCount; n++) {
    if (pos + 46 > bytes.byteLength || view.getUint32(pos, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError('the archive is damaged');
    }
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const externalAttributes = view.getUint32(pos + 38, true);
    const localOffset = view.getUint32(pos + 42, true);
    const nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;
    if (nameBytes.byteLength !== nameLength) throw new ZipError('the archive is damaged');
    const name = new TextDecoder('utf-8').decode(nameBytes);

    if (name.endsWith('/')) continue; // a folder
    if (flags & 0x1) throw new ZipError('encrypted archives are not supported');
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new ZipError(`"${name}" is a symbolic link`);
    const path = safeZipPath(name);
    if (seen.has(path)) throw new ZipError(`"${path}" appears twice`);
    seen.add(path);
    if (size > limits.maxFileBytes) throw new ZipError(`"${path}" is too large`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError('the archive is too large when unpacked');

    if (
      localOffset + 30 > bytes.byteLength ||
      view.getUint32(localOffset, true) !== LOCAL_SIGNATURE
    ) {
      throw new ZipError('the archive is damaged');
    }
    const dataStart =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (compressed.byteLength !== compressedSize) throw new ZipError('the archive is damaged');

    let data: Uint8Array;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new ZipError(`"${path}" could not be unpacked`);
      }
    } else {
      throw new ZipError(`"${path}" uses an unsupported compression method`);
    }
    if (data.byteLength !== size) throw new ZipError(`"${path}" has the wrong size`);
    files.push({ path, data });
  }
  return files;
}
