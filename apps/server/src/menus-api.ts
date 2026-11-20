import {
  MenuNotFoundError,
  MenuValidationError,
  type Capabilities,
  type MenuService,
} from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';

export interface MenusRoutesOptions {
  menus: Pick<
    MenuService,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'getLocations' | 'setLocations'
  >;
  capabilities: Capabilities;
  /** The menu locations of the active theme (`name` → label); empty without a theme. */
  locations: () => Record<string, string>;
}

const MAX_BODY_BYTES = 256 * 1024;

/** A router that is uncached, same-origin, signed in and limited to `edit_theme_options`. */
function guarded(auth: Auth, capabilities: Capabilities): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use('*', auth.originGuard);
  routes.use('*', auth.authenticate);
  routes.use('*', async (c, next) => {
    if (!(await capabilities.can(c.get('principal')!.user, 'edit_theme_options'))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });
  return routes;
}

async function readBody(c: Context<AuthEnv>): Promise<Record<string, unknown> | Response> {
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
  return body as Record<string, unknown>;
}

function fail(c: Context<AuthEnv>, error: unknown) {
  if (error instanceof MenuValidationError) {
    return c.json({ error: 'invalid_request', field: error.field, message: error.message }, 400);
  }
  if (error instanceof MenuNotFoundError) return c.json({ error: 'not_found' }, 404);
  throw error;
}

/**
 * Routes for `/api/v1/menus`: list, create, read, update (name and/or items) and delete.
 * Needs `edit_theme_options`. Bad input is a 400 that names the field; nothing is saved then.
 */
export function createMenusRoutes(auth: Auth, options: MenusRoutesOptions): Hono<AuthEnv> {
  const { menus } = options;
  const routes = guarded(auth, options.capabilities);
  const menuId = (c: Context<AuthEnv>): number | undefined => {
    const raw = c.req.param('id') ?? '';
    return /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : undefined;
  };

  routes.get('/', async (c) => c.json({ menus: await menus.list() }));

  routes.post('/', async (c) => {
    const body = await readBody(c);
    if (body instanceof Response) return body;
    try {
      return c.json({ menu: await menus.create(body) }, 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.get('/:id', async (c) => {
    const id = menuId(c);
    const menu = id === undefined ? undefined : await menus.get(id);
    return menu ? c.json({ menu }) : c.json({ error: 'not_found' }, 404);
  });

  routes.patch('/:id', async (c) => {
    const id = menuId(c);
    if (id === undefined) return c.json({ error: 'not_found' }, 404);
    const body = await readBody(c);
    if (body instanceof Response) return body;
    try {
      return c.json({ menu: await menus.update(id, body) });
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.delete('/:id', async (c) => {
    const id = menuId(c);
    if (id === undefined || !(await menus.delete(id))) return c.json({ error: 'not_found' }, 404);
    return c.body(null, 204);
  });

  return routes;
}

/**
 * Routes for `/api/v1/menu-locations`: `GET` lists the active theme's menu locations and the
 * menu assigned to each; `PUT` assigns (`{ "primary": 3 }`) or clears (`null`) locations.
 * Needs `edit_theme_options`.
 */
export function createMenuLocationsRoutes(auth: Auth, options: MenusRoutesOptions): Hono<AuthEnv> {
  const { menus, locations } = options;
  const routes = guarded(auth, options.capabilities);

  routes.get('/', async (c) =>
    c.json({ locations: locations(), assigned: await menus.getLocations() }),
  );

  routes.put('/', async (c) => {
    const body = await readBody(c);
    if (body instanceof Response) return body;
    try {
      const assigned = await menus.setLocations(body, Object.keys(locations()));
      return c.json({ locations: locations(), assigned });
    } catch (error) {
      return fail(c, error);
    }
  });

  return routes;
}
