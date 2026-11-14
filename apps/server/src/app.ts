import type {
  Capabilities,
  ContentService,
  ContentTypeRegistry,
  MediaService,
  NodePress,
  OptionsService,
  PermalinkService,
  StorageAdapter,
  TaxonomyService,
  UsersService,
  WebhookService,
} from '@nodepress/core';
import type { ContentMetaTableStore, DatabaseHandle } from '@nodepress/db';
import { Hono } from 'hono';
import { createAdminHandler } from './admin.js';
import { createAuth, type AuthOptions } from './auth.js';
import { createContentRoutes } from './content-api.js';
import { createTaxonomyRoutes } from './taxonomy-api.js';
import { createMediaRoutes, createUploadsHandler } from './media.js';
import { createUserRoutes } from './users-api.js';
import { createWebhookRoutes } from './webhooks.js';

declare module '@nodepress/core' {
  interface FilterMap {
    /** Final HTML of a front-end page, just before it is sent. */
    'render:html': { value: string; context: { path: string } };
  }
}

/** Build the HTTP app. Kept separate from `main.ts` so it can be tested without a port. */
export interface AppOptions {
  /** Enables `/api/v1/auth/*` (login, logout, me) and, with `apiTokens`, `/api/v1/tokens`. */
  auth?: AuthOptions;
  /**
   * Enables the front-end resolver: any other GET path is looked up as content (200),
   * redirected (301, e.g. after a slug change) or answered with a 404 page.
   */
  permalinks?: PermalinkService;
  /**
   * Enables media uploads: `/api/v1/media` (needs `auth`) and public files at `/uploads/*`.
   */
  media?: { service: MediaService; storage: StorageAdapter; capabilities: Capabilities };
  /**
   * Enables the content REST API (needs `auth`): `/api/v1/content/:type`,
   * `/api/v1/content-types` and the OpenAPI document at `/api/v1/openapi.json`.
   *
   * Optional parts: `meta` stores and returns custom field values, `taxonomies` assigns and
   * returns terms, and `options` lets the `api_public_read` setting open published reads to
   * anonymous visitors.
   */
  content?: {
    service: ContentService;
    types: ContentTypeRegistry;
    capabilities: Capabilities;
    meta?: ContentMetaTableStore;
    taxonomies?: TaxonomyService;
    options?: OptionsService;
  };
  /**
   * Enables `/api/v1/users` (needs `auth`): list, create and edit users (name, email, role).
   * Reading needs `list_users`, editing `edit_users`, changing a role `promote_users`.
   */
  users?: {
    service: Pick<UsersService, 'list' | 'findById' | 'create' | 'update'>;
    capabilities: Capabilities;
  };
  /** Enables `/api/v1/webhooks` (needs `auth`): manage webhooks, `manage_options` only. */
  webhooks?: { service: WebhookService; capabilities: Capabilities };
  /** Serves the built admin app (`dir` = its `dist` folder) at `/admin`. */
  admin?: { dir: string };
}

export function createApp(np: NodePress, database: DatabaseHandle, options: AppOptions = {}): Hono {
  const app = new Hono();

  if (options.auth) {
    const auth = createAuth(options.auth);
    app.route('/api/v1/auth', auth.routes);
    if (options.auth.apiTokens) app.route('/api/v1/tokens', auth.tokenRoutes);
    if (options.content) {
      app.route(
        '/api/v1',
        createContentRoutes(auth, {
          content: options.content.service,
          types: options.content.types,
          capabilities: options.content.capabilities,
          hooks: np.hooks,
          ...(options.content.meta ? { meta: options.content.meta } : {}),
          ...(options.content.taxonomies ? { taxonomies: options.content.taxonomies } : {}),
          ...(options.content.options ? { options: options.content.options } : {}),
        }),
      );
    }
    if (options.content?.taxonomies) {
      app.route(
        '/api/v1/taxonomies',
        createTaxonomyRoutes(auth, {
          taxonomies: options.content.taxonomies,
          capabilities: options.content.capabilities,
        }),
      );
    }
    if (options.users) {
      app.route(
        '/api/v1/users',
        createUserRoutes(auth, {
          users: options.users.service,
          capabilities: options.users.capabilities,
        }),
      );
    }
    if (options.webhooks) {
      app.route(
        '/api/v1/webhooks',
        createWebhookRoutes(auth, {
          webhooks: options.webhooks.service,
          capabilities: options.webhooks.capabilities,
        }),
      );
    }
    if (options.media) {
      app.route(
        '/api/v1/media',
        createMediaRoutes(auth, {
          media: options.media.service,
          storage: options.media.storage,
          capabilities: options.media.capabilities,
        }),
      );
    }
  }
  if (options.media) app.get('/uploads/*', createUploadsHandler(options.media.storage));
  if (options.admin) {
    const admin = createAdminHandler(options.admin);
    app.get('/admin', admin);
    app.get('/admin/*', admin);
  }

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

  const { permalinks } = options;
  if (permalinks) {
    // Registered last so every API and system route above wins.
    app.get('*', async (c) => {
      const path = c.req.path;
      if (path === '/api' || path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
      const route = await permalinks.resolve(path);
      if (route.kind === 'redirect') {
        const query = new URL(c.req.url).search;
        return c.redirect(route.to + query, route.status);
      }
      const siteName = String(np.config.siteName ?? 'NodePress');
      // Temporary markup until the theme system lands in Phase 3.
      const [title, heading, status] =
        route.kind === 'content'
          ? [route.content.title, route.content.title, 200 as const]
          : ['Page not found', 'Page not found', 404 as const];
      const excerpt = route.kind === 'content' ? (route.content.excerpt ?? '') : '';
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} | ${escapeHtml(siteName)}</title>
  </head>
  <body>
    <h1>${escapeHtml(heading)}</h1>
    ${excerpt ? `<p>${escapeHtml(excerpt)}</p>` : ''}
  </body>
</html>`;
      return c.html(await np.hooks.applyFilters('render:html', html, { path }), status);
    });
  }

  return app;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}
