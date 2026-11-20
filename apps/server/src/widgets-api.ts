import { WidgetValidationError, type Capabilities, type WidgetService } from '@nodepress/core';
import type { Context, Hono } from 'hono';
import type { Auth, AuthEnv } from './auth.js';
import { guarded, readBody } from './menus-api.js';

export interface WidgetsRoutesOptions {
  widgets: Pick<WidgetService, 'types' | 'getAreas' | 'setAreas'>;
  capabilities: Capabilities;
  /** The widget areas of the active theme (`name` → label); empty without a theme. */
  areas: () => Record<string, string>;
}

function fail(c: Context<AuthEnv>, error: unknown) {
  if (error instanceof WidgetValidationError) {
    return c.json({ error: 'invalid_request', field: error.field, message: error.message }, 400);
  }
  throw error;
}

/**
 * Routes for `/api/v1/widgets`. `GET` returns the active theme's widget areas (`areas`: name →
 * label), the widgets in each (`widgets`) and the widget types that can be added (`types`).
 * `PUT` replaces the widgets of the areas it names (`{ "sidebar": [{ "type": "text", "settings":
 * { "text": "Hello" } }] }`); other areas are kept. Needs `edit_theme_options`. Bad input is a
 * 400 that names the field and nothing is saved then.
 */
export function createWidgetsRoutes(auth: Auth, options: WidgetsRoutesOptions): Hono<AuthEnv> {
  const { widgets, areas } = options;
  const routes = guarded(auth, options.capabilities);

  const overview = async () => ({
    areas: areas(),
    widgets: await widgets.getAreas(Object.keys(areas())),
    types: widgets.types(),
  });

  routes.get('/', async (c) => c.json(await overview()));

  routes.put('/', async (c) => {
    const body = await readBody(c);
    if (body instanceof Response) return body;
    try {
      await widgets.setAreas(body, Object.keys(areas()));
      return c.json(await overview());
    } catch (error) {
      return fail(c, error);
    }
  });

  return routes;
}
