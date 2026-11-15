import { SettingValidationError, type Capabilities, type SettingsService } from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';

export interface SettingsRoutesOptions {
  settings: Pick<SettingsService, 'getAll' | 'update'>;
  capabilities: Capabilities;
}

const MAX_BODY_BYTES = 8 * 1024;

/**
 * Routes for `/api/v1/settings`: `GET` returns every setting, `PATCH` changes some of them.
 * Both need `manage_options`. The keys are a fixed list (see `SETTING_KEYS`); an unknown key
 * or an invalid value is a 400 that names the key, and then nothing is saved.
 */
export function createSettingsRoutes(auth: Auth, options: SettingsRoutesOptions): Hono<AuthEnv> {
  const { settings, capabilities } = options;
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

  routes.get('/', async (c) => c.json({ settings: await settings.getAll() }));

  routes.patch('/', async (c: Context<AuthEnv>) => {
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
      return c.json({ settings: await settings.update(body as Record<string, unknown>) });
    } catch (error) {
      if (error instanceof SettingValidationError) {
        return c.json({ error: 'invalid_request', field: error.key, message: error.message }, 400);
      }
      throw error;
    }
  });

  return routes;
}
