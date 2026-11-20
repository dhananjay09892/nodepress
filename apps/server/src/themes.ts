import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { TemplateComponent, TemplateProps, ThemeService } from '@nodepress/core';
import type { Handler } from 'hono';
import { TYPES } from './admin.js';

/** URL prefix of a theme's static files: `/themes/<name>/assets/<file>`. */
export function themeAssetsUrl(name: string): string {
  return `/themes/${name}/assets`;
}

/** Theme files may be cached for a day; the ETag lets browsers revalidate cheaply after that. */
export const THEME_ASSET_CACHE = 'public, max-age=86400';

/**
 * Serves `/themes/:name/assets/*` from the theme's assets folder. Only installed themes are
 * served, paths cannot leave the folder (including through symlinks), and responses carry
 * `Cache-Control` and an `ETag` (a matching `If-None-Match` gets a 304).
 */
export function createThemeAssetsHandler(themes: Pick<ThemeService, 'get'>): Handler {
  const notFound = (c: Parameters<Handler>[0]) => c.json({ error: 'not_found' }, 404);

  return async (c) => {
    const name = c.req.param('name') ?? '';
    const theme = themes.get(name);
    if (!theme) return notFound(c);

    const prefix = `${themeAssetsUrl(name)}/`;
    let relative: string;
    try {
      relative = decodeURIComponent(c.req.path.slice(prefix.length));
    } catch {
      return notFound(c);
    }
    if (relative === '' || relative.includes('\0') || relative.includes('\\')) return notFound(c);

    const root = resolve(theme.assetsDir);
    const target = resolve(root, relative);
    if (!target.startsWith(root + sep)) return notFound(c);
    try {
      // Resolve symlinks so a link inside the folder cannot point outside it.
      const real = await realpath(target);
      const realRoot = await realpath(root);
      if (!real.startsWith(realRoot + sep)) return notFound(c);
      const info = await stat(real);
      if (!info.isFile()) return notFound(c);

      const etag = `"${createHash('sha1').update(`${info.size}:${info.mtimeMs}`).digest('hex').slice(0, 20)}"`;
      const headers: Record<string, string> = {
        'cache-control': THEME_ASSET_CACHE,
        etag,
        'x-content-type-options': 'nosniff',
      };
      if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
      const body = await readFile(real);
      headers['content-type'] = TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream';
      return c.body(new Uint8Array(body), 200, headers);
    } catch {
      return notFound(c);
    }
  };
}

/**
 * Render a template to an HTML string. Templates are components (TSX) that return JSX nodes,
 * strings or promises of them; anything with a `toString()` that yields HTML works. A leading
 * doctype is added when the template did not write one.
 */
export async function renderTemplate(
  component: TemplateComponent,
  props: TemplateProps,
): Promise<string> {
  const result = await component(props);
  const html =
    result === null || result === undefined || result === false
      ? ''
      : await (result as { toString(): string | Promise<string> }).toString();
  return /^\s*<!doctype/i.test(html) ? html : `<!doctype html>${html}`;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Whether `value` is a link to an image: empty (none), a site path or an http(s) address. */
function isImageUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  if (value.length > 2000 || CONTROL.test(value) || /\s/.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//') && !value.includes('\\');
  return /^https?:\/\/[^\s/?#]+/i.test(value);
}

/** Whether `value` fits the setting `spec` (one entry of a theme's `settings` schema). */
export function settingFits(spec: Record<string, unknown>, value: unknown): boolean {
  const { type, options } = spec;
  if (type === 'select') return Array.isArray(options) && options.includes(value);
  if (type === 'color') return typeof value === 'string' && HEX_COLOR.test(value);
  if (type === 'image') return isImageUrl(value);
  if (type === 'string' || type === 'boolean' || type === 'number') return typeof value === type;
  return false;
}

/**
 * The settings a template receives: the `default` of every setting in `theme.json`, with
 * `overrides` applied for known keys whose value fits the schema (`select` values must be one
 * of `options`; `color` a `#rgb` or `#rrggbb` value; `image` empty, a site path or an http(s)
 * address; `string`, `boolean` and `number` must have that type). Unknown keys and bad values
 * are ignored, so a stale or hand-edited override can never break a template.
 */
export function resolveThemeSettings(
  schema: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema)) {
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) continue;
    const fields = spec as Record<string, unknown>;
    if (settingFits(fields, overrides[key])) result[key] = overrides[key];
    else if (settingFits(fields, fields.default)) result[key] = fields.default;
  }
  return result;
}
