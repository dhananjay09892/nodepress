import {
  discoverPlugins,
  installPluginZip,
  listPluginPackages,
  PluginPackageError,
  type Capabilities,
  type PluginInfo,
  type PluginStateService,
} from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';

export const MAX_PLUGIN_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface PluginRoutesOptions {
  /** The plugins folder. */
  dir: string;
  state: PluginStateService;
  capabilities: Capabilities;
  /** How the running site treats each package (from the plugin manager). */
  running: () => PluginInfo[];
  /** Names of the packages that were loaded when the site started. */
  loaded: () => string[];
}

/**
 * Routes for `/api/v1/plugins`. Need the `manage_plugins` capability; a session (with CSRF token)
 * or a Bearer API token.
 *
 * - `GET /`: installed packages with their declared permissions, whether they are enabled and
 *   how they are running, broken folders, and whether a restart is needed.
 * - `POST /`: install a plugin from a raw `.zip` body (`Content-Type: application/zip`). It stays
 *   off until enabled.
 * - `PATCH /:name` with `{ "enabled": boolean }`: turn it on or off. Plugin code is loaded when
 *   the site starts, so changes apply after a restart (`restartRequired`).
 */
export function createPluginRoutes(auth: Auth, options: PluginRoutesOptions): Hono<AuthEnv> {
  const { capabilities } = options;
  const routes = new Hono<AuthEnv>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use('*', auth.originGuard);
  routes.use('*', auth.authenticate);
  routes.use('*', async (c, next) => {
    if (!(await capabilities.can(c.get('principal')!.user, 'manage_plugins'))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });

  const snapshot = async () => {
    const listed = await listPluginPackages({
      dir: options.dir,
      state: options.state,
      running: options.running,
    });
    const enabled = new Set(listed.plugins.filter((p) => p.enabled).map((p) => p.name));
    const loaded = new Set(options.loaded());
    const restartRequired =
      enabled.size !== loaded.size || [...enabled].some((name) => !loaded.has(name));
    return { ...listed, restartRequired };
  };

  const fail = (c: Context<AuthEnv>, error: unknown) => {
    if (error instanceof PluginPackageError) {
      return c.json({ error: 'invalid_plugin', message: error.message }, 400);
    }
    throw error;
  };

  routes.get('/', async (c) => c.json(await snapshot()));

  routes.post('/', async (c) => {
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (!type.startsWith('application/zip') && !type.startsWith('application/octet-stream')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > MAX_PLUGIN_UPLOAD_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_PLUGIN_UPLOAD_BYTES)
      return c.json({ error: 'payload_too_large' }, 413);
    try {
      const installed = await installPluginZip({ dir: options.dir, zip: bytes });
      const state = await snapshot();
      return c.json(
        { plugin: state.plugins.find((p) => p.name === installed.manifest.name), ...state },
        201,
      );
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.patch('/:name', async (c) => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') {
      return c.json({ error: 'invalid_request', message: '"enabled" must be true or false' }, 400);
    }
    const name = c.req.param('name');
    const found = (await discoverPlugins(options.dir)).plugins.find(
      (p) => p.manifest.name === name,
    );
    if (!found) return c.json({ error: 'not_found' }, 404);
    try {
      await options.state.setEnabled(name, enabled, found.manifest.version);
    } catch (error) {
      return fail(c, error);
    }
    const state = await snapshot();
    return c.json({ plugin: state.plugins.find((p) => p.name === name), ...state });
  });

  return routes;
}
