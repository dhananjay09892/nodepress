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
