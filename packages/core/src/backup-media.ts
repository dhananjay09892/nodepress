import { z } from 'zod';
import { silentLogger, type Logger } from './logger.js';
import type { Media, MediaService, StorageAdapter } from './media.js';
import { MediaValidationError } from './media.js';
import { readZip, safeZipPath, writeZip, ZipError, type ZipFile } from './zip.js';

/** Name of the manifest inside a media zip. */
export const MEDIA_MANIFEST = 'manifest.json';
export const MEDIA_ZIP_FORMAT = 'nodepress-media';
export const MEDIA_ZIP_VERSION = 1;
/** Most files a media zip holds or an import reads. */
export const MAX_MEDIA_FILES = 20_000;
/** Largest media zip, in bytes of file data. */
export const MAX_MEDIA_ZIP_BYTES = 256 * 1024 * 1024;

export interface MediaManifestEntry {
  /** Id of the file on the site that made the backup. */
  id: number;
  /** Path inside the zip. */
  file: string;
  mime: string;
  alt: string;
  size: number;
}

export interface MediaManifest {
  format: typeof MEDIA_ZIP_FORMAT;
  version: typeof MEDIA_ZIP_VERSION;
  exportedAt: string;
  media: MediaManifestEntry[];
  /** Files left out and why (missing from storage, or the zip was full). */
  omitted: Array<{ id: number; reason: string }>;
}

export interface MediaBackupDeps {
  media: Pick<MediaService, 'list'>;
  storage: Pick<StorageAdapter, 'get'>;
  logger?: Logger;
  now?: () => Date;
  /** Cap on the bytes of file data in the zip. Default `MAX_MEDIA_ZIP_BYTES`. */
  maxBytes?: number;
}

export interface MediaExportResult {
  zip: Uint8Array;
  manifest: MediaManifest;
}

/** The extension of a storage key, lowercase, or an empty string. */
function extensionOf(path: string): string {
  const leaf = path.split('/').pop() ?? '';
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '') : '';
}

/**
 * Every original file in the media library (variants are made again on import) with a manifest of
 * ids, alt text and MIME types. A file missing from storage, or one that would take the zip past
 * its size cap, is left out and named in `manifest.omitted`.
 */
export async function exportMediaZip(deps: MediaBackupDeps): Promise<MediaExportResult> {
  const logger = deps.logger ?? silentLogger;
  const cap = deps.maxBytes ?? MAX_MEDIA_ZIP_BYTES;
  const files: ZipFile[] = [];
  const entries: MediaManifestEntry[] = [];
  const omitted: MediaManifest['omitted'] = [];
  let total = 0;
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const page: Media[] = await deps.media.list({ limit: pageSize, offset });
    for (const item of page) {
      if (entries.length >= MAX_MEDIA_FILES) {
        omitted.push({ id: item.id, reason: 'too many files for one zip' });
        continue;
      }
      const bytes = await deps.storage.get(item.path);
      if (!bytes) {
        logger.warn(`Media ${item.id} (${item.path}) is missing from storage.`);
        omitted.push({ id: item.id, reason: 'file missing from storage' });
        continue;
      }
      if (total + bytes.byteLength > cap) {
        omitted.push({ id: item.id, reason: 'zip size limit reached' });
        continue;
      }
      total += bytes.byteLength;
      const file = `media/${item.id}${extensionOf(item.path)}`;
      files.push({ path: file, data: bytes });
      entries.push({ id: item.id, file, mime: item.mime, alt: item.alt, size: bytes.byteLength });
    }
    if (page.length < pageSize) break;
  }
  const manifest: MediaManifest = {
    format: MEDIA_ZIP_FORMAT,
    version: MEDIA_ZIP_VERSION,
    exportedAt: (deps.now ?? (() => new Date()))().toISOString(),
    media: entries,
    omitted,
  };
  files.unshift({
    path: MEDIA_MANIFEST,
    data: new TextEncoder().encode(JSON.stringify(manifest)),
  });
  return { zip: writeZip(files), manifest };
}

const manifestSchema = z.object({
  format: z.literal(MEDIA_ZIP_FORMAT),
  version: z.literal(MEDIA_ZIP_VERSION),
  exportedAt: z.string().max(40),
  media: z
    .array(
      z.object({
        id: z.number().int(),
        file: z.string().min(1).max(300),
        mime: z.string().max(100),
        alt: z.string().max(2000),
        size: z.number().int().nonnegative(),
      }),
    )
    .max(MAX_MEDIA_FILES),
  omitted: z
    .array(z.object({ id: z.number().int(), reason: z.string().max(200) }))
    .max(MAX_MEDIA_FILES)
    .optional(),
});

export class MediaBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaBackupError';
  }
}

export interface MediaImportDeps {
  media: Pick<MediaService, 'upload' | 'maxBytes'>;
  logger?: Logger;
}

export interface MediaImportSummary {
  imported: number;
  /** Old media id → new media id. */
  idMap: Record<string, number>;
  failed: Array<{ id: number; file: string; reason: string }>;
}

/**
 * Restore the files of a media zip through the media service, so type, size and variant rules
 * apply exactly as for an upload. The reader is strict (see `readZip`); a bad zip or manifest
 * changes nothing. A file that is refused is reported and the others go on. Files are added next
 * to the existing ones.
 */
export async function importMediaZip(
  bytes: Uint8Array,
  deps: MediaImportDeps,
  options: { uploadedBy?: number | null } = {},
): Promise<MediaImportSummary> {
  const logger = deps.logger ?? silentLogger;
  let files: ZipFile[];
  try {
    files = readZip(bytes, {
      maxEntries: MAX_MEDIA_FILES + 1,
      maxFileBytes: Math.max(deps.media.maxBytes, 1024 * 1024),
      maxTotalBytes: MAX_MEDIA_ZIP_BYTES + 1024 * 1024,
    });
  } catch (error) {
    if (error instanceof ZipError) throw new MediaBackupError(`Not a usable zip: ${error.message}`);
    throw error;
  }
  const manifestFile = files.find((f) => f.path === MEDIA_MANIFEST);
  if (!manifestFile) throw new MediaBackupError('This is not a NodePress media backup.');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(manifestFile.data));
  } catch {
    throw new MediaBackupError('The manifest is not valid JSON.');
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MediaBackupError(
      `This is not a NodePress media backup${issue ? ` (${issue.path.join('.') || 'manifest'}: ${issue.message})` : ''}.`,
    );
  }
  const byPath = new Map(files.map((f) => [f.path, f.data]));
  const summary: MediaImportSummary = { imported: 0, idMap: {}, failed: [] };
  const seenIds = new Set<number>();
  for (const entry of parsed.data.media) {
    try {
      if (seenIds.has(entry.id)) throw new Error('listed twice in the manifest');
      seenIds.add(entry.id);
      const data = byPath.get(safeZipPath(entry.file));
      if (!data) throw new Error('file missing from the zip');
      const created = await deps.media.upload({
        data,
        filename: entry.file.split('/').pop() ?? 'file',
        declaredMime: entry.mime,
        alt: entry.alt,
        uploadedBy: options.uploadedBy ?? null,
      });
      summary.idMap[String(entry.id)] = created.id;
      summary.imported++;
    } catch (error) {
      const reason =
        error instanceof MediaValidationError || error instanceof Error
          ? error.message
          : String(error);
      logger.warn(`Media ${entry.id} (${entry.file}) was not restored: ${reason}`);
      summary.failed.push({ id: entry.id, file: entry.file, reason });
    }
  }
  return summary;
}

type Block = { type?: unknown; attrs?: unknown; children?: unknown; [key: string]: unknown };

/**
 * A copy of `blocks` where every `mediaId` attribute (as a string) is replaced through `idMap`
 * (old id → new id). Child blocks are followed. A `mediaId` with no entry is counted in
 * `unmapped` and left as it was.
 */
export function remapBlockMedia(
  blocks: unknown[],
  idMap: Readonly<Record<string, number>>,
): { blocks: unknown[]; unmapped: number } {
  let unmapped = 0;
  const walk = (list: unknown[]): unknown[] =>
    list.map((raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
      const block = { ...(raw as Block) };
      if (typeof block.attrs === 'object' && block.attrs !== null && !Array.isArray(block.attrs)) {
        const attrs = { ...(block.attrs as Record<string, unknown>) };
        const id = attrs['mediaId'];
        if (typeof id === 'string' || typeof id === 'number') {
          const mapped = idMap[String(id)];
          if (mapped === undefined) unmapped++;
          else attrs['mediaId'] = String(mapped);
        }
        block.attrs = attrs;
      }
      if (Array.isArray(block.children)) block.children = walk(block.children);
      return block;
    });
  return { blocks: walk(blocks), unmapped };
}
