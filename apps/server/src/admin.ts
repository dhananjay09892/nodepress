import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Context, Handler } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
};

// The admin is a same-origin SPA: no inline scripts, no third-party hosts.
const INDEX_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export interface AdminHandlerOptions {
  /** Directory with the built admin app (`apps/admin/dist`). */
  dir: string;
}

/**
 * Serves the built admin SPA under `/admin`: files from `dir`, long-lived caching for the
 * hashed files in `assets/`, and `index.html` for any other path so client-side routes work
 * on reload. Paths that look like a file but do not exist are a real 404.
 */
export function createAdminHandler(options: AdminHandlerOptions): Handler {
  const root = resolve(options.dir);

  async function readFileIn(relative: string): Promise<Buffer | null> {
    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(root + sep)) return null;
    try {
      if (!(await stat(target)).isFile()) return null;
      return await readFile(target);
    } catch {
      return null;
    }
  }

  const send = (c: Context, body: Buffer, file: string, cache: string): Response => {
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      'content-type': type,
      'cache-control': cache,
    };
    if (type.startsWith('text/html')) headers['content-security-policy'] = INDEX_CSP;
    return c.body(new Uint8Array(body), 200, headers);
  };

  return async (c) => {
    const path = c.req.path;
    if (path === '/admin') return c.redirect('/admin/', 301);

    let relative: string;
    try {
      relative = decodeURIComponent(path.slice('/admin/'.length));
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
    if (relative.includes('\0') || relative.includes('\\'))
      return c.json({ error: 'not_found' }, 404);

    if (relative !== '' && relative !== 'index.html') {
      const file = await readFileIn(relative);
      if (file) {
        const hashed = relative.startsWith('assets/');
        return send(c, file, relative, hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      }
      // Something with an extension is a missing file, not a client-side route.
      if (extname(relative) !== '') return c.json({ error: 'not_found' }, 404);
    }

    const index = await readFileIn('index.html');
    if (!index) return c.json({ error: 'admin_not_built' }, 404);
    return send(c, index, 'index.html', 'no-cache');
  };
}
