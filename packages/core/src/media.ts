import { randomBytes } from 'node:crypto';
import type { HookRegistry } from './hooks.js';
import { silentLogger, type Logger } from './logger.js';

/** A row of the media table as the service sees it. */
export interface MediaRecord {
  id: number;
  /** Storage key of the original, e.g. `uploads/2026/11/cat-1a2b3c4d.jpg`. */
  path: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string;
  /** Variant name → storage key, e.g. `{ thumbnail: "uploads/2026/11/cat-1a2b3c4d-thumbnail.jpg" }`. */
  variants: Record<string, string>;
  uploadedBy: number | null;
  createdAt: Date;
}

export type Media = MediaRecord;

export interface NewMediaRecord {
  path: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string;
  variants: Record<string, string>;
  uploadedBy: number | null;
}

export interface MediaRecordQuery {
  limit: number;
  offset: number;
  /** Only files uploaded by this user. */
  uploadedBy?: number;
}

/** Storage behind the media service. `@nodepress/db` provides `createMediaStore()`. */
export interface MediaStore {
  insert(row: NewMediaRecord): Promise<MediaRecord>;
  findById(id: number): Promise<MediaRecord | undefined>;
  /** Newest first. */
  list(query: MediaRecordQuery): Promise<MediaRecord[]>;
  updateAlt(id: number, alt: string): Promise<MediaRecord | undefined>;
  delete(id: number): Promise<boolean>;
}

/** Where file bytes live. The local-disk adapter ships in core; S3-compatible ones come later. */
export interface StorageAdapter {
  /** Store `data` under `key`. Never overwrites: a key that already exists is an error. */
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  /** The bytes, or `undefined` if the key does not exist. */
  get(key: string): Promise<Buffer | undefined>;
  /** Remove a key. Removing a key that does not exist is not an error. */
  delete(key: string): Promise<void>;
}

export type RasterFormat = 'jpeg' | 'png' | 'webp';

export interface ResizeOptions {
  width: number;
  /** Omit to keep the aspect ratio. */
  height?: number;
  /** `cover` crops to exactly width x height; `inside` fits within the box. */
  fit: 'cover' | 'inside';
  format: RasterFormat;
}

/** Image work the service needs. `createSharpProcessor()` is the production implementation. */
export interface ImageProcessor {
  /** Pixel size of an image. Throws if the bytes are not a readable image. */
  inspect(data: Buffer): Promise<{ width: number; height: number }>;
  /** Resize and re-encode, never enlarging. Metadata (EXIF, GPS) is not carried over. */
  resize(data: Buffer, options: ResizeOptions): Promise<Buffer>;
}

declare module './hooks.js' {
  interface ActionMap {
    'media:uploaded': [media: MediaRecord];
    'media:deleted': [media: MediaRecord];
  }
  interface FilterMap {
    /**
     * MIME types the media library accepts. Plugins can remove types (for example to forbid
     * PDFs); types the core cannot recognise from their content are ignored if added.
     */
    'media:allowed-types': { value: string[]; context: undefined };
  }
}

export interface DetectedType {
  mime: string;
  ext: string;
  image: boolean;
}

/**
 * Types NodePress recognises by content. SVG is deliberately absent: it can carry scripts.
 */
export const DETECTABLE_TYPES: readonly DetectedType[] = [
  { mime: 'image/jpeg', ext: 'jpg', image: true },
  { mime: 'image/png', ext: 'png', image: true },
  { mime: 'image/gif', ext: 'gif', image: true },
  { mime: 'image/webp', ext: 'webp', image: true },
  { mime: 'application/pdf', ext: 'pdf', image: false },
];

/** Identify a file from its first bytes. The filename and declared type are never trusted. */
export function detectType(data: Uint8Array): DetectedType | undefined {
  const at = (i: number) => data[i];
  const text = (start: number, value: string) =>
    data.length >= start + value.length &&
    [...value].every((ch, i) => data[start + i] === ch.charCodeAt(0));
  let mime: string | undefined;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) mime = 'image/jpeg';
  else if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => data[i] === byte)) {
    mime = 'image/png';
  } else if (text(0, 'GIF87a') || text(0, 'GIF89a')) mime = 'image/gif';
  else if (text(0, 'RIFF') && text(8, 'WEBP')) mime = 'image/webp';
  else if (text(0, '%PDF-')) mime = 'application/pdf';
  return DETECTABLE_TYPES.find((t) => t.mime === mime);
}

export type MediaErrorCode =
  'empty' | 'too_large' | 'unsupported_type' | 'type_mismatch' | 'invalid_image' | 'invalid_alt';

export class MediaValidationError extends Error {
  readonly code: MediaErrorCode;
  constructor(code: MediaErrorCode, message: string) {
    super(message);
    this.name = 'MediaValidationError';
    this.code = code;
  }
}

export class MediaNotFoundError extends Error {
  constructor(id: number) {
    super(`Media ${id} not found`);
    this.name = 'MediaNotFoundError';
  }
}

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Decoding a decompression bomb costs memory; refuse images above this many pixels. */
export const DEFAULT_MAX_PIXELS = 50_000_000;
export const MAX_ALT_LENGTH = 500;
export const MAX_FILENAME_BASE_LENGTH = 60;
export const DEFAULT_MEDIA_LIST_LIMIT = 50;
export const MAX_MEDIA_LIST_LIMIT = 200;

export interface VariantSize {
  width: number;
  height?: number;
  fit: 'cover' | 'inside';
}

/** Raster variants generated for every image. `medium`/`large` are skipped for smaller originals. */
export const VARIANT_SIZES: Readonly<Record<'thumbnail' | 'medium' | 'large', VariantSize>> = {
  thumbnail: { width: 150, height: 150, fit: 'cover' },
  medium: { width: 300, fit: 'inside' },
  large: { width: 1024, fit: 'inside' },
};

export interface MediaServiceOptions {
  store: MediaStore;
  storage: StorageAdapter;
  processor: ImageProcessor;
  hooks: HookRegistry;
  logger?: Logger;
  maxBytes?: number;
  maxPixels?: number;
  /** Clock, injectable for tests (used for the year/month folders). */
  now?: () => Date;
}

export interface UploadInput {
  data: Uint8Array;
  /** Original filename; only used to build a readable, safe storage name. */
  filename: string;
  /** Type claimed by the client. If given, it must match what the content really is. */
  declaredMime?: string | undefined;
  alt?: string | undefined;
  uploadedBy?: number | null | undefined;
}

export interface ListMediaOptions {
  limit?: number;
  offset?: number;
  uploadedBy?: number;
}

/** Make a filename safe to embed in a storage key: lowercase ASCII letters, digits and dashes. */
export function safeBaseName(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop() ?? '';
  const dot = leaf.lastIndexOf('.');
  const base = dot > 0 ? leaf.slice(0, dot) : leaf;
  const slug = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_FILENAME_BASE_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'file';
}

export class MediaService {
  readonly #store: MediaStore;
  readonly #storage: StorageAdapter;
  readonly #processor: ImageProcessor;
  readonly #hooks: HookRegistry;
  readonly #logger: Logger;
  readonly #maxBytes: number;
  readonly #maxPixels: number;
  readonly #now: () => Date;

  constructor(options: MediaServiceOptions) {
    this.#store = options.store;
    this.#storage = options.storage;
    this.#processor = options.processor;
    this.#hooks = options.hooks;
    this.#logger = options.logger ?? silentLogger;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    this.#maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
    this.#now = options.now ?? (() => new Date());
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  /** Validate, store the original, generate variants and record the file. */
  async upload(input: UploadInput): Promise<Media> {
    const { data } = input;
    if (data.byteLength === 0) throw new MediaValidationError('empty', 'the file is empty');
    if (data.byteLength > this.#maxBytes) {
      throw new MediaValidationError(
        'too_large',
        `the file is larger than ${this.#maxBytes} bytes`,
      );
    }
    const alt = (input.alt ?? '').trim();
    if (alt.length > MAX_ALT_LENGTH) {
      throw new MediaValidationError('invalid_alt', `alt text is limited to ${MAX_ALT_LENGTH}`);
    }

    const detected = detectType(data);
    const allowed = await this.#allowedTypes();
    if (!detected || !allowed.has(detected.mime)) {
      throw new MediaValidationError('unsupported_type', 'this file type is not allowed');
    }
    const declared = input.declaredMime?.split(';')[0]?.trim().toLowerCase();
    if (declared && declared !== 'application/octet-stream' && declared !== detected.mime) {
      throw new MediaValidationError(
        'type_mismatch',
        `the file content is ${detected.mime}, not ${declared}`,
      );
    }

    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    let width: number | null = null;
    let height: number | null = null;
    if (detected.image) {
      try {
        ({ width, height } = await this.#processor.inspect(buffer));
      } catch {
        throw new MediaValidationError('invalid_image', 'the image could not be read');
      }
      if (!(width > 0 && height > 0) || width * height > this.#maxPixels) {
        throw new MediaValidationError('invalid_image', 'the image dimensions are not allowed');
      }
    }

    const now = this.#now();
    const folder = `uploads/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const stem = `${folder}/${safeBaseName(input.filename)}-${randomBytes(4).toString('hex')}`;
    const written: string[] = [];
    const put = async (key: string, bytes: Uint8Array, mime: string) => {
      await this.#storage.put(key, bytes, mime);
      written.push(key);
    };

    try {
      const path = `${stem}.${detected.ext}`;
      await put(path, data, detected.mime);
      const variants: Record<string, string> = {};
      if (detected.image && width !== null && height !== null) {
        const sourceFormat: RasterFormat =
          detected.mime === 'image/jpeg' ? 'jpeg' : detected.mime === 'image/png' ? 'png' : 'webp';
        const ext = sourceFormat === 'jpeg' ? 'jpg' : sourceFormat;
        for (const [name, size] of Object.entries(VARIANT_SIZES)) {
          if (name !== 'thumbnail' && width <= size.width) continue;
          const bytes = await this.#processor.resize(buffer, {
            ...size,
            format: sourceFormat,
          });
          const key = `${stem}-${name}.${ext}`;
          await put(key, bytes, `image/${sourceFormat}`);
          variants[name] = key;
        }
        if (sourceFormat !== 'webp') {
          const bytes = await this.#processor.resize(buffer, {
            width,
            fit: 'inside',
            format: 'webp',
          });
          const key = `${stem}.webp`;
          await put(key, bytes, 'image/webp');
          variants.webp = key;
        }
      }

      const record = await this.#store.insert({
        path,
        mime: detected.mime,
        size: data.byteLength,
        width,
        height,
        alt,
        variants,
        uploadedBy: input.uploadedBy ?? null,
      });
      await this.#hooks.doAction('media:uploaded', record);
      return record;
    } catch (error) {
      await Promise.all(
        written.map((key) =>
          this.#storage
            .delete(key)
            .catch((e) => this.#logger.warn(`Could not clean up ${key}: ${String(e)}`)),
        ),
      );
      throw error;
    }
  }

  async get(id: number): Promise<Media | undefined> {
    return this.#store.findById(id);
  }

  async list(options: ListMediaOptions = {}): Promise<Media[]> {
    const limit = Math.min(
      Math.max(Math.trunc(options.limit ?? DEFAULT_MEDIA_LIST_LIMIT) || 1, 1),
      MAX_MEDIA_LIST_LIMIT,
    );
    const offset = Math.max(Math.trunc(options.offset ?? 0) || 0, 0);
    return this.#store.list({
      limit,
      offset,
      ...(options.uploadedBy !== undefined ? { uploadedBy: options.uploadedBy } : {}),
    });
  }

  async updateAlt(id: number, alt: string): Promise<Media> {
    const trimmed = alt.trim();
    if (trimmed.length > MAX_ALT_LENGTH) {
      throw new MediaValidationError('invalid_alt', `alt text is limited to ${MAX_ALT_LENGTH}`);
    }
    const updated = await this.#store.updateAlt(id, trimmed);
    if (!updated) throw new MediaNotFoundError(id);
    return updated;
  }

  /** Delete the record and then every file (original and variants). Returns false if unknown. */
  async delete(id: number): Promise<boolean> {
    const record = await this.#store.findById(id);
    if (!record) return false;
    if (!(await this.#store.delete(id))) return false;
    for (const key of [record.path, ...Object.values(record.variants)]) {
      // The record is gone either way; a leftover file is logged, not surfaced.
      await this.#storage
        .delete(key)
        .catch((e) => this.#logger.warn(`Could not delete ${key}: ${String(e)}`));
    }
    await this.#hooks.doAction('media:deleted', record);
    return true;
  }

  async #allowedTypes(): Promise<Set<string>> {
    const builtIn = DETECTABLE_TYPES.map((t) => t.mime);
    const filtered = await this.#hooks.applyFilters('media:allowed-types', [...builtIn]);
    const list = Array.isArray(filtered) ? filtered : builtIn;
    return new Set(list.filter((m): m is string => builtIn.includes(m)));
  }
}

export function createMediaService(options: MediaServiceOptions): MediaService {
  return new MediaService(options);
}
