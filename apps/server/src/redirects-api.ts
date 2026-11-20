import {
  MAX_CSV_BYTES,
  RedirectNotFoundError,
  RedirectValidationError,
  type Capabilities,
  type RedirectsService,
} from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';
import { readBody } from './menus-api.js';

export interface RedirectsRoutesOptions {
  redirects: Pick<
    RedirectsService,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'importCsv' | 'match'
  >;
  capabilities: Capabilities;
}

function fail(c: Context<AuthEnv>, error: unknown) {
  if (error instanceof RedirectValidationError) {
    return c.json({ error: 'invalid_request', field: error.field, message: error.message }, 400);
  }
  if (error instanceof RedirectNotFoundError) return c.json({ error: 'not_found' }, 404);
  throw error;
}

/**
 * Routes for `/api/v1/redirects` (`manage_options`, signed in; session writes need the CSRF token):
 * `GET /` lists, `POST /` creates (`{ from, to, status? }`), `PATCH /:id` updates, `DELETE /:id`
 * removes, and `POST /import` takes a CSV body (`text/csv`, `from,to[,status]`, 1 MB at most) and
 * answers with how many rules were created and updated and which lines were refused.
 */
export function createRedirectsRoutes(auth: Auth, options: RedirectsRoutesOptions): Hono<AuthEnv> {
  const { redirects, capabilities } = options;
  const routes = new Hono<AuthEnv>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use('*', auth.originGuard);
  routes.use('*', auth.authenticate);
  routes.use('*', async (c, next) => {
    if (!(await capabilities.can(c.get('principal')!.user, 'manage_options'))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });
  const ruleId = (c: Context<AuthEnv>): number | undefined => {
    const raw = c.req.param('id') ?? '';
    return /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : undefined;
  };

  routes.get('/', async (c) => c.json({ redirects: await redirects.list() }));

  routes.post('/import', async (c) => {
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (!type.startsWith('text/csv') && !type.startsWith('text/plain')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_CSV_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    try {
      return c.json(await redirects.importCsv(text));
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.post('/', async (c) => {
    const body = await readBody(c);
    if (body instanceof Response) return body;
    try {
      return c.json({ redirect: await redirects.create(body as { from: unknown; to: unknown }) }, 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.patch('/:id', async (c) => {
    const id = ruleId(c);
    if (id === undefined) return c.json({ error: 'not_found' }, 404);
    const body = await readBody(c);
    if (body instanceof Response) return body;
    try {
      return c.json({ redirect: await redirects.update(id, body) });
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.delete('/:id', async (c) => {
    const id = ruleId(c);
    if (id === undefined) return c.json({ error: 'not_found' }, 404);
    try {
      await redirects.delete(id);
      return c.body(null, 204);
    } catch (error) {
      return fail(c, error);
    }
  });

  return routes;
}
