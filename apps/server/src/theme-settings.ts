import type { Capabilities, OptionsService, ThemeService } from '@nodepress/core';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { Auth, AuthEnv } from './auth.js';
import { guarded, readBody } from './menus-api.js';
import { resolveThemeSettings, settingFits } from './themes.js';

/** Option holding the customizer's saved values: theme name → setting → value. */
export const THEME_SETTINGS_OPTION = 'theme_settings';

/** A setting as the customizer API describes it. */
export interface ThemeSettingInfo {
  key: string;
  type: string;
  label: string;
  options?: unknown[];
  default?: unknown;
}

/** The settings of a theme's `theme.json`, in a form the admin can draw. Malformed entries are skipped. */
export function describeSettings(schema: Record<string, unknown>): ThemeSettingInfo[] {
  const out: ThemeSettingInfo[] = [];
  for (const [key, spec] of Object.entries(schema)) {
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) continue;
    const { type, label, options, default: fallback } = spec as Record<string, unknown>;
    if (typeof type !== 'string') continue;
    out.push({
      key,
      type,
      label: typeof label === 'string' && label !== '' ? label : key,
      ...(Array.isArray(options) ? { options } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
    });
  }
  return out;
}

export class ThemeSettingsError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ThemeSettingsError';
  }
}

/**
 * Saved customizer values per theme, kept in the options table (`theme_settings`). Only keys of
 * the theme's schema with a fitting value are kept; reading never fails on stale data.
 */
export class ThemeSettingsService {
  readonly #options: Pick<OptionsService, 'get' | 'set'>;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: Pick<OptionsService, 'get' | 'set'>) {
    this.#options = options;
  }

  async #all(): Promise<Record<string, Record<string, unknown>>> {
    const stored = await this.#options.get(THEME_SETTINGS_OPTION);
    return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, Record<string, unknown>>)
      : {};
  }

  /** The values saved for `theme` (only known keys that still fit the schema). */
  async saved(theme: string, schema: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = (await this.#all())[theme] ?? {};
    const kept: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(schema)) {
      if (typeof spec === 'object' && spec !== null && settingFits(spec as Record<string, unknown>, raw[key])) {
        kept[key] = raw[key];
      }
    }
    return kept;
  }

  /**
   * Change saved values: `patch` maps a setting to its new value, or to `null` to go back to
   * the theme's default. Nothing is saved when any key or value is refused.
   */
  async update(
    theme: string,
    schema: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    for (const [key, value] of Object.entries(patch)) {
      const spec = schema[key];
      if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
        throw new ThemeSettingsError(key, `"${key}" is not a setting of this theme`);
      }
      if (value !== null && !settingFits(spec as Record<string, unknown>, value)) {
        throw new ThemeSettingsError(key, `${key} does not accept that value`);
      }
    }
    const run = this.#queue.then(async () => {
      const all = await this.#all();
      const next = { ...(await this.saved(theme, schema)) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      await this.#options.set(THEME_SETTINGS_OPTION, { ...all, [theme]: next });
      return next;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

export interface ThemeSettingsRoutesOptions {
  themes: Pick<ThemeService, 'active'>;
  settings: ThemeSettingsService;
  capabilities: Capabilities;
}

/**
 * Routes for `/api/v1/theme-settings` (needs `edit_theme_options`). `GET` describes the active
 * theme's settings, the saved values and the values in effect; `PATCH` changes saved values
 * (`{ "values": { "accent": "#aa0000", "layout": null } }`, `null` resets one to its default).
 */
export function createThemeSettingsRoutes(
  auth: Auth,
  options: ThemeSettingsRoutesOptions,
): Hono<AuthEnv> {
  const routes = guarded(auth, options.capabilities);

  async function overview(c: Context<AuthEnv>) {
    const theme = options.themes.active;
    if (!theme) return c.json({ error: 'no_active_theme' }, 404);
    const schema = theme.manifest.settings;
    const saved = await options.settings.saved(theme.manifest.name, schema);
    return c.json({
      theme: { name: theme.manifest.name, title: theme.manifest.title },
      settings: describeSettings(schema),
      saved,
      values: resolveThemeSettings(schema, saved),
    });
  }

  routes.get('/', (c) => overview(c));

  routes.patch('/', async (c) => {
    const theme = options.themes.active;
    if (!theme) return c.json({ error: 'no_active_theme' }, 404);
    const body = await readBody(c);
    if (body instanceof Response) return body;
    const values = body['values'];
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      return c.json({ error: 'invalid_request', field: 'values', message: 'values must be an object' }, 400);
    }
    try {
      await options.settings.update(theme.manifest.name, theme.manifest.settings, values as Record<string, unknown>);
    } catch (error) {
      if (error instanceof ThemeSettingsError) {
        return c.json({ error: 'invalid_request', field: error.field, message: error.message }, 400);
      }
      throw error;
    }
    return overview(c);
  });

  return routes;
}
