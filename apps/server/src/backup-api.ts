import {
  BackupError,
  exportMediaZip,
  exportSite,
  importMediaZip,
  importSite,
  MAX_EXPORT_BYTES,
  MAX_MEDIA_ZIP_BYTES,
  MediaBackupError,
  type BackupDeps,
  type Capabilities,
  type MediaService,
  type OptionsService,
  type StorageAdapter,
} from '@nodepress/core';
import { Hono } from 'hono';
import type { Auth, AuthEnv } from './auth.js';
import { readLimited } from './media.js';

/** Option holding the old → new media ids of the last media restore, until a JSON restore uses it. */
export const BACKUP_MEDIA_MAP_OPTION = 'backup_media_map';

export interface BackupRoutesOptions extends BackupDeps {
  capabilities: Capabilities;
  /** The media library, for the media zip. Without it the media routes answer 404. */
  media?: {
    service: Pick<MediaService, 'list' | 'upload' | 'maxBytes'>;
    storage: Pick<StorageAdapter, 'get'>;
  };
  /** Where the media id map waits between restoring the media zip and the JSON file. */
  options?: Pick<OptionsService, 'get' | 'set' | 'delete'>;
}

/**
 * Routes for `/api/v1/backup` (`manage_options`; session writes need the CSRF token):
 * - `GET /`: `{ maxBytes, media }`, the largest file `POST /import` takes and whether media can be
 *   backed up.
 * - `GET /media`: a zip of every original in the media library with a `manifest.json` (ids, alt
 *   text, MIME types). Files that could not be included are named in the manifest and counted in
 *   the `x-nodepress-media-omitted` header.
 * - `POST /media` (`application/zip`): restore such a zip through the media service (type, size and
 *   variant rules apply; refused files are reported). The old → new ids are kept for the next
 *   `POST /import`, which then points `featured_image` and image blocks at the new files; restore
 *   the media first.
 * - `GET /export`: the whole site's content (every status, with custom fields and terms),
 *   terms, settings, menus, widgets and redirect rules as one JSON download. No users, passwords, tokens or secrets.
 * - `POST /import`: read such a file back (`application/json`, up to 256 MB). Content is added
 *   next to what is already there (nothing is changed or deleted). Items go to the user whose
 *   email matches the author in the file, else to the user running the import. Custom fields
 *   that point at media (`featured_image`) are left out until media is restored (N61), and the
 *   answer says so. One import at a time (`409`).
 */
export function createBackupRoutes(auth: Auth, options: BackupRoutesOptions): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();
  let running = false;
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use('*', auth.originGuard);
  routes.use('*', auth.authenticate);
  routes.use('*', async (c, next) => {
    if (!(await options.capabilities.can(c.get('principal')!.user, 'manage_options'))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });

  // For the admin screen: whether the user may use backups, and the largest file an import takes.
  routes.get('/', (c) =>
    c.json({ maxBytes: MAX_EXPORT_BYTES, media: options.media !== undefined }),
  );

  routes.get('/media', async (c) => {
    if (!options.media) return c.json({ error: 'not_found' }, 404);
    const { zip, manifest } = await exportMediaZip({
      media: options.media.service,
      storage: options.media.storage,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    const day = manifest.exportedAt.slice(0, 10);
    return c.body(zip as unknown as ArrayBuffer, 200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="nodepress-media-${day}.zip"`,
      'x-nodepress-media-omitted': String(manifest.omitted.length),
    });
  });

  routes.post('/media', async (c) => {
    if (!options.media) return c.json({ error: 'not_found' }, 404);
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (!type.startsWith('application/zip') && !type.startsWith('application/octet-stream')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    if (running) return c.json({ error: 'import_running' }, 409);
    running = true;
    try {
      const body = await readLimited(c.req.raw, MAX_MEDIA_ZIP_BYTES + 1024 * 1024);
      if (body === null) return c.json({ error: 'payload_too_large' }, 413);
      try {
        const summary = await importMediaZip(
          body,
          {
            media: options.media.service,
            ...(options.logger ? { logger: options.logger } : {}),
          },
          { uploadedBy: c.get('principal')!.user.id },
        );
        if (options.options)
          await options.options.set(BACKUP_MEDIA_MAP_OPTION, summary.idMap, { autoload: false });
        return c.json({ imported: summary.imported, failed: summary.failed });
      } catch (error) {
        if (error instanceof MediaBackupError) {
          return c.json({ error: 'invalid_media_backup', message: error.message }, 400);
        }
        throw error;
      }
    } finally {
      running = false;
    }
  });

  routes.get('/export', async (c) => {
    const data = await exportSite(options);
    const day = data.exportedAt.slice(0, 10);
    return c.body(JSON.stringify(data), 200, {
      'content-type': 'application/json; charset=UTF-8',
      'content-disposition': `attachment; filename="nodepress-export-${day}.json"`,
    });
  });

  routes.post('/import', async (c) => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    if (running) return c.json({ error: 'import_running' }, 409);
    running = true;
    try {
      const body = await readLimited(c.req.raw, MAX_EXPORT_BYTES);
      if (body === null) return c.json({ error: 'payload_too_large' }, 413);
      let data: unknown;
      try {
        data = JSON.parse(body.toString('utf8'));
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const user = c.get('principal')!.user;
      const cache = new Map<string, number | null>();
      // The ids of a media zip restored just before, used once.
      const stored = options.options ? await options.options.get(BACKUP_MEDIA_MAP_OPTION) : null;
      const mediaMap = isIdMap(stored) ? stored : undefined;
      try {
        const summary = await importSite(data, options, {
          defaultAuthorId: user.id,
          ...(mediaMap ? { mediaMap } : { skipMeta: ['featured_image'] }),
          resolveAuthor: async (author) => {
            const key = author.email.toLowerCase();
            if (!cache.has(key)) {
              const users = options.users ? await options.users.list() : [];
              cache.set(key, users.find((u) => u.email.toLowerCase() === key)?.id ?? null);
            }
            return cache.get(key) ?? user.id;
          },
        });
        if (mediaMap && options.options) await options.options.delete(BACKUP_MEDIA_MAP_OPTION);
        return c.json(summary);
      } catch (error) {
        if (error instanceof BackupError) {
          return c.json({ error: 'invalid_export', message: error.message }, 400);
        }
        throw error;
      }
    } finally {
      running = false;
    }
  });

  return routes;
}

function isIdMap(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((v) => typeof v === 'number')
  );
}
