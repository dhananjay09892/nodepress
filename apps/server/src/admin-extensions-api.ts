import {
  AdminExtensionError,
  PanelValidationError,
  type AdminExtensions,
  type Capabilities,
} from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';

export interface AdminExtensionsRoutesOptions {
  registry: Pick<AdminExtensions, 'describe' | 'getPage' | 'readPanel' | 'writePanel'>;
  capabilities: Capabilities;
}

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Routes for `/api/v1/admin-extensions`, what plugins added to the admin:
 *
 * - `GET /` lists the menu items and pages the signed-in person may use (any signed-in user).
 * - `GET /:plugin/:page` returns the saved values of every settings panel on a page.
 * - `PATCH /:plugin/:page/:panel` saves some fields of one panel.
 *
 * A page needs the capability its plugin chose (default `manage_options`), checked on every
 * request. An unknown page is a 404; a page the person may not use is a 403. An invalid value
 * is a 400 that names the field, and then nothing is saved.
 */
export function createAdminExtensionsRoutes(
  auth: Auth,
  options: AdminExtensionsRoutesOptions,
): Hono<AuthEnv> {
  const { registry, capabilities } = options;
  const routes = new Hono<AuthEnv>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use('*', auth.originGuard);
  routes.use('*', auth.authenticate);

  routes.get('/', async (c) => {
    const user = c.get('principal')!.user;
    return c.json(await registry.describe((capability) => capabilities.can(user, capability)));
  });

  /** The page, or the response to send instead (404 unknown, 403 not allowed). */
  async function openPage(c: Context<AuthEnv>, plugin: string, pageId: string) {
    const page = registry.getPage(plugin, pageId);
    if (!page) return { response: c.json({ error: 'not_found' }, 404) } as const;
    const user = c.get('principal')!.user;
    if (!(await capabilities.can(user, page.capability ?? 'manage_options'))) {
      return { response: c.json({ error: 'forbidden' }, 403) } as const;
    }
    return { page } as const;
  }

  routes.get('/:plugin/:page', async (c) => {
    const { plugin, page: pageId } = c.req.param();
    const opened = await openPage(c, plugin, pageId);
    if ('response' in opened) return opened.response;
    const values: Record<string, Record<string, unknown>> = {};
    for (const panel of opened.page.panels) {
      values[panel.id] = await registry.readPanel(plugin, pageId, panel.id);
    }
    return c.json({ values });
  });

  routes.patch('/:plugin/:page/:panel', async (c) => {
    const { plugin, page: pageId, panel } = c.req.param();
    const opened = await openPage(c, plugin, pageId);
    if ('response' in opened) return opened.response;
    if (!opened.page.panels.some((p) => p.id === panel)) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    try {
      return c.json({ values: await registry.writePanel(plugin, pageId, panel, body) });
    } catch (error) {
      if (error instanceof PanelValidationError) {
        const first = error.issues[0];
        return c.json(
          {
            error: 'invalid_request',
            field: first?.path ?? '',
            message: first?.message ?? 'Invalid value',
          },
          400,
        );
      }
      if (error instanceof AdminExtensionError) return c.json({ error: 'not_found' }, 404);
      throw error;
    }
  });

  return routes;
}
