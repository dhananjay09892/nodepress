import {
  BackupError,
  exportSite,
  importSite,
  MAX_EXPORT_BYTES,
  type BackupDeps,
  type Capabilities,
} from '@nodepress/core';
import { Hono } from 'hono';
import type { Auth, AuthEnv } from './auth.js';
import { readLimited } from './media.js';

export interface BackupRoutesOptions extends BackupDeps {
  capabilities: Capabilities;
}

/**
 * Routes for `/api/v1/backup` (`manage_options`; session writes need the CSRF token):
 * - `GET /export`: the whole site's content (every status, with custom fields and terms),
 *   terms and settings as one JSON download. No users, passwords, tokens or secrets.
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
      try {
        const summary = await importSite(data, options, {
          defaultAuthorId: user.id,
          skipMeta: ['featured_image'],
          resolveAuthor: async (author) => {
            const key = author.email.toLowerCase();
            if (!cache.has(key)) {
              const users = options.users ? await options.users.list() : [];
              cache.set(key, users.find((u) => u.email.toLowerCase() === key)?.id ?? null);
            }
            return cache.get(key) ?? user.id;
          },
        });
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
