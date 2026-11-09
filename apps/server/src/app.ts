import type { NodePress } from '@nodepress/core';
import type { DatabaseHandle } from '@nodepress/db';
import { Hono } from 'hono';
import { createAuth, type AuthOptions } from './auth.js';

declare module '@nodepress/core' {
  interface FilterMap {
    /** Final HTML of a front-end page, just before it is sent. */
    'render:html': { value: string; context: { path: string } };
  }
}

/** Build the HTTP app. Kept separate from `main.ts` so it can be tested without a port. */
export interface AppOptions {
  /** Enables `/api/v1/auth/*` (login, logout, me). */
  auth?: AuthOptions;
}

export function createApp(np: NodePress, database: DatabaseHandle, options: AppOptions = {}): Hono {
  const app = new Hono();

  if (options.auth) app.route('/api/v1/auth', createAuth(options.auth).routes);

  app.get('/api/health', async (c) => {
    const dbOk = await database.ping();
    return c.json(
      {
        status: dbOk ? 'ok' : 'degraded',
        kernel: np.state,
        database: dbOk ? 'connected' : 'unreachable',
        plugins: np.plugins.list().map(({ name, status }) => ({ name, status })),
      },
      dbOk ? 200 : 503,
    );
  });

  // Temporary front page until the theme system lands in Phase 3.
  app.get('/', async (c) => {
    const siteName = String(np.config.siteName ?? 'NodePress');
    const post = await np.hooks.applyFilters('post:content', '<p>Welcome to your new site.</p>');
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(siteName)}</title>
  </head>
  <body>
    <h1>${escapeHtml(siteName)}</h1>
    ${String(post)}
  </body>
</html>`;
    return c.html(await np.hooks.applyFilters('render:html', html, { path: c.req.path }));
  });

  return app;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}
