import {
  importWordPress,
  MAX_WXR_BYTES,
  WxrError,
  type Capabilities,
  type ContentService,
  type ImportReport,
  type Logger,
  type PermalinkService,
  type RedirectsService,
  type TaxonomyService,
  type UsersService,
} from '@nodepress/core';
import { Hono } from 'hono';
import type { Auth, AuthEnv } from './auth.js';
import { readLimited } from './media.js';

export interface ImportRoutesOptions {
  content: Pick<ContentService, 'create' | 'update'>;
  taxonomies: Pick<TaxonomyService, 'getTermBySlug' | 'createTerm' | 'setContentTerms'>;
  permalinks: Pick<PermalinkService, 'pathFor'>;
  meta?: { setMeta(contentId: number, values: Record<string, unknown>): Promise<void> };
  users: Pick<UsersService, 'findByEmail' | 'findById'>;
  capabilities: Capabilities;
  /** Where the redirect map of the old site is saved. Without it the map is only returned. */
  redirects?: Pick<RedirectsService, 'addMany'>;
  logger?: Logger;
}

export interface WordPressImportResponse extends ImportReport {
  /** Authors of the export that were matched to a user by email. */
  authorsMatched: number;
  /** Redirects saved from the map (`created`) and the ones that were not (`skipped`). */
  redirectsSaved?: { created: number; skipped: Array<{ from: string; message: string }> };
}

/**
 * Routes for `/api/v1/import`:
 * - `POST /wordpress`: the body is a WordPress export (WXR, `application/xml` or `text/xml`, up
 *   to 25 MB). Needs `manage_options` (session with CSRF token, or a Bearer token). Items are
 *   assigned to the user whose email matches the WordPress author, else to the user running the
 *   import (or to `?default_author=<user id>`); `?match_authors=false` gives everything to that
 *   default author. The old URLs found in the export are saved as 301 redirects when the site
 *   has redirects enabled. Answers with the import report; one bad item never stops the rest.
 *   Only one import runs at a time (`409` otherwise).
 */
export function createImportRoutes(auth: Auth, options: ImportRoutesOptions): Hono<AuthEnv> {
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

  routes.post('/wordpress', async (c) => {
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (!type.startsWith('application/xml') && !type.startsWith('text/xml')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    const user = c.get('principal')!.user;
    let defaultAuthorId: number = user.id;
    const requested = c.req.query('default_author');
    if (requested !== undefined) {
      const id = /^[1-9]\d{0,9}$/.test(requested) ? Number(requested) : undefined;
      if (id === undefined || !(await options.users.findById(id))) {
        return c.json({ error: 'invalid_request', message: 'default_author is not a user.' }, 400);
      }
      defaultAuthorId = id;
    }
    const matchAuthors = c.req.query('match_authors') !== 'false';

    if (running) return c.json({ error: 'import_running' }, 409);
    running = true;
    try {
      const body = await readLimited(c.req.raw, MAX_WXR_BYTES);
      if (body === null) return c.json({ error: 'payload_too_large' }, 413);
      let matched = 0;
      const cache = new Map<string, number | null>();
      let report: ImportReport;
      try {
        report = await importWordPress(body.toString('utf8'), {
          content: options.content,
          taxonomies: options.taxonomies,
          permalinks: options.permalinks,
          ...(options.meta ? { meta: options.meta } : {}),
          defaultAuthorId,
          resolveAuthor: async (author) => {
            if (!matchAuthors || !author.email) return defaultAuthorId;
            const key = author.email.toLowerCase();
            if (!cache.has(key)) {
              const found = await options.users.findByEmail(author.email).catch(() => undefined);
              cache.set(key, found ? found.id : null);
              if (found) matched++;
            }
            return cache.get(key) ?? defaultAuthorId;
          },
          ...(options.logger ? { logger: options.logger } : {}),
        });
      } catch (error) {
        if (error instanceof WxrError) {
          return c.json({ error: 'invalid_wxr', message: error.message }, 400);
        }
        throw error;
      }
      const response: WordPressImportResponse = { ...report, authorsMatched: matched };
      if (options.redirects && report.redirects.length > 0) {
        response.redirectsSaved = await options.redirects.addMany(
          report.redirects.map((r) => ({ from: r.from, to: r.to, status: 301 })),
        );
      }
      return c.json(response);
    } finally {
      running = false;
    }
  });

  return routes;
}
