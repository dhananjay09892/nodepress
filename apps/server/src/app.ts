import type {
  Capabilities,
  Content,
  ContentService,
  ContentTypeRegistry,
  MediaService,
  MenuService,
  MetaTags,
  WidgetService,
  PageCache,
  NodePress,
  OptionsService,
  PermalinkService,
  SettingsService,
  StorageAdapter,
  TaxonomyService,
  TemplateTarget,
  ThemeService,
  UsersService,
  WebhookService,
} from '@nodepress/core';
import type { ContentMetaTableStore, DatabaseHandle } from '@nodepress/db';
import { Hono, type Context } from 'hono';
import { createAdminExtensionsRoutes } from './admin-extensions-api.js';
import { createAdminHandler } from './admin.js';
import { createAuth, type AuthEnv, type AuthOptions } from './auth.js';
import { createContactRoutes, type ContactRoutesOptions } from './contact-api.js';
import { createContentRoutes } from './content-api.js';
import { createTaxonomyRoutes } from './taxonomy-api.js';
import { createMediaRoutes, createUploadsHandler } from './media.js';
import { createMenuLocationsRoutes, createMenusRoutes } from './menus-api.js';
import { createPluginRoutes, type PluginRoutesOptions } from './plugins-api.js';
import { createWidgetsRoutes } from './widgets-api.js';
import { buildMeta, filterMeta } from './meta.js';
import { cleanSiteUrl, createFeedRoutes, type FeedRoutesOptions } from './feeds.js';
import { createPageCacheMiddleware } from './page-cache.js';
import { createThemeSettingsRoutes, type ThemeSettingsService } from './theme-settings.js';
import { createSettingsRoutes } from './settings-api.js';
import {
  createThemeAssetsHandler,
  renderTemplate,
  resolveThemeSettings,
  themeAssetsUrl,
} from './themes.js';
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
   * Enables `/api/v1/users` (needs `auth`): list, create, edit and delete users, and set a new
   * password. Reading needs `list_users`, editing `edit_users`, deleting `delete_users`,
   * changing a role `promote_users`.
   */
  users?: {
    service: Pick<UsersService, 'list' | 'findById' | 'create' | 'update' | 'delete'>;
    capabilities: Capabilities;
    /** Ends a user's sessions after a password reset or a delete. */
    sessions?: { destroyAllForUser(userId: number): Promise<number> };
    /** Moves a deleted user's content to another user, or to nobody (`null`). */
    reassignContent?: (fromId: number, toId: number | null) => Promise<number>;
  };
  /**
   * Enables `/api/v1/settings` (needs `auth`): read and change the site settings,
   * `manage_options` only.
   */
  settings?: { service: Pick<SettingsService, 'getAll' | 'update'>; capabilities: Capabilities };
  /**
   * Enables `/api/v1/menus` and `/api/v1/menu-locations` (needs `auth`): build navigation menus
   * and assign them to the active theme's menu locations, `edit_theme_options` only. With
   * `themes`, templates also receive the assigned menus as `menus`.
   */
  menus?: {
    service: Pick<
      MenuService,
      | 'list'
      | 'get'
      | 'create'
      | 'update'
      | 'delete'
      | 'getLocations'
      | 'setLocations'
      | 'forLocations'
    >;
    capabilities: Capabilities;
  };
  /**
   * Enables `/api/v1/widgets` (needs `auth`): place widgets in the active theme's widget areas,
   * `edit_theme_options` only. With `themes`, templates also receive the rendered widgets as
   * `widgets`.
   */
  widgets?: {
    service: Pick<WidgetService, 'types' | 'getAreas' | 'setAreas' | 'forAreas'>;
    capabilities: Capabilities;
  };
  /**
   * Enables `/api/v1/theme-settings` (needs `auth` and `themes`): the theme customizer's saved
   * values, `edit_theme_options` only. Signed-in users with that capability can also preview
   * unsaved values on any themed page with `?np_preview=<JSON of setting values>`.
   */
  themeSettings?: { service: ThemeSettingsService; capabilities: Capabilities };
  /**
   * Serves `/sitemap.xml` and `/feed.xml`. Needs `permalinks`. `siteUrl` is the public address
   * used in absolute links; without it the request's own origin is used.
   */
  feeds?: Omit<FeedRoutesOptions, 'permalinks'>;
  /**
   * A full-page cache for anonymous visitors (see `createPageCacheMiddleware`). The caller is
   * responsible for `cache.attach()`, which purges it when content or options change.
   */
  pageCache?: PageCache;
  /**
   * Enables `/api/v1/contact` (needs `auth` for the admin list): a public contact form endpoint
   * with spam protection, and the stored messages for `manage_options`.
   */
  contact?: ContactRoutesOptions;
  /** Enables `/api/v1/webhooks` (needs `auth`): manage webhooks, `manage_options` only. */
  webhooks?: { service: WebhookService; capabilities: Capabilities };
  /**
   * Enables `/api/v1/plugins` (needs `auth`): list, upload (.zip) and enable or disable plugin
   * packages; `manage_plugins` only. See `createPluginRoutes`.
   */
  plugins?: PluginRoutesOptions;
  /**
   * Enables `/api/v1/admin-extensions` (needs `auth`): the menu items, pages and settings
   * panels plugins add to the admin (`np.admin`). Each page needs the capability its plugin
   * chose; panel values are stored through the options service (`np.admin.useOptions()`).
   */
  adminExtensions?: { capabilities: Capabilities };
  /**
   * Draws content pages and the 404 page with the active theme's templates (the template
   * hierarchy picks the file) and serves theme files at `/themes/:name/assets/*`. Needs
   * `permalinks`. Without an active theme, or if a template fails, the built-in page is used.
   * `renderBody` turns a content item's blocks into HTML for the template's `html` prop.
   */
  themes?: {
    service: ThemeService;
    renderBody?: (content: Content) => string | Promise<string>;
    /** Overrides for the theme's settings (see `resolveThemeSettings`); defaults come from `theme.json`. */
    settings?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
    /** Site tagline shown by themes. */
    tagline?: () => string | Promise<string>;
    /** Latest published posts for the front page (newest first). */
    latestPosts?: () => Promise<Content[]>;
    /** Path or URL of an item's featured image (for `og:image`), if it has one. */
    featuredImage?: (content: Content) => Promise<string | undefined>;
    /**
     * The public address of the site (for example `https://example.com`) used in canonical and
     * Open Graph URLs; without it, or one set in `feeds`, the request's own origin is used.
     */
    siteUrl?: string | undefined;
  };
  /** Serves the built admin app (`dir` = its `dist` folder) at `/admin`. */
  admin?: { dir: string };
}

export function createApp(np: NodePress, database: DatabaseHandle, options: AppOptions = {}): Hono {
  const app = new Hono();
  if (options.pageCache) app.use('*', createPageCacheMiddleware(options.pageCache));

  const sessionAuth = options.auth ? createAuth(options.auth) : undefined;
  if (options.auth && sessionAuth) {
    const auth = sessionAuth;
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
          ...(options.users.sessions ? { sessions: options.users.sessions } : {}),
          ...(options.users.reassignContent
            ? { reassignContent: options.users.reassignContent }
            : {}),
        }),
      );
    }
    if (options.settings) {
      app.route(
        '/api/v1/settings',
        createSettingsRoutes(auth, {
          settings: options.settings.service,
          capabilities: options.settings.capabilities,
        }),
      );
    }
    if (options.menus) {
      const menuRoutes = {
        menus: options.menus.service,
        capabilities: options.menus.capabilities,
        locations: () => options.themes?.service.active?.manifest.menus ?? {},
      };
      app.route('/api/v1/menus', createMenusRoutes(auth, menuRoutes));
      app.route('/api/v1/menu-locations', createMenuLocationsRoutes(auth, menuRoutes));
    }
    if (options.themeSettings && options.themes) {
      app.route(
        '/api/v1/theme-settings',
        createThemeSettingsRoutes(auth, {
          themes: options.themes.service,
          settings: options.themeSettings.service,
          capabilities: options.themeSettings.capabilities,
        }),
      );
    }
    if (options.widgets) {
      app.route(
        '/api/v1/widgets',
        createWidgetsRoutes(auth, {
          widgets: options.widgets.service,
          capabilities: options.widgets.capabilities,
          areas: () => options.themes?.service.active?.manifest.widgetAreas ?? {},
        }),
      );
    }
    if (options.adminExtensions) {
      app.route(
        '/api/v1/admin-extensions',
        createAdminExtensionsRoutes(auth, {
          registry: np.admin,
          capabilities: options.adminExtensions.capabilities,
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
    if (options.contact) app.route('/api/v1/contact', createContactRoutes(auth, options.contact));
    if (options.plugins) app.route('/api/v1/plugins', createPluginRoutes(auth, options.plugins));
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
  if (options.themes) {
    app.get('/themes/:name/assets/*', createThemeAssetsHandler(options.themes.service));
  }
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

  const { permalinks, themes } = options;

  /** The page drawn by the active theme, or undefined to use the built-in page. */
  /**
   * Unsaved customizer values from `?np_preview=<JSON>`, only for a signed-in user who may edit
   * theme options; everyone else gets `undefined` and the normal page. Such pages are never cached.
   */
  async function previewOverrides(c: Context): Promise<Record<string, unknown> | undefined> {
    const raw = c.req.query('np_preview');
    if (raw === undefined || !sessionAuth || !options.themeSettings) return undefined;
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex');
    if (raw.length > 4096) return undefined;
    const authContext = c as unknown as Context<AuthEnv>;
    await sessionAuth.loadSession(authContext, async () => {});
    const user = authContext.get('auth')?.user;
    if (!user || !(await options.themeSettings.capabilities.can(user, 'edit_theme_options'))) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function buildPageMeta(
    route: { kind: 'content'; content: Content } | { kind: 'not_found' } | { kind: 'front' },
    path: string,
    siteName: string,
    status: 200 | 404,
    requestUrl: string,
    tagline: string,
  ): Promise<MetaTags> {
    const base =
      cleanSiteUrl(options.themes?.siteUrl ?? options.feeds?.siteUrl) ?? new URL(requestUrl).origin;
    const content = route.kind === 'content' ? route.content : undefined;
    const image =
      content && options.themes?.featuredImage
        ? await options.themes.featuredImage(content).catch(() => undefined)
        : undefined;
    const built = buildMeta({
      base,
      path,
      status,
      siteName,
      tagline,
      content,
      image,
      hasFeed: Boolean(options.feeds && permalinks),
    });
    return filterMeta(np.hooks, built, { path, status, content });
  }

  async function renderThemed(
    route: { kind: 'content'; content: Content } | { kind: 'not_found' } | { kind: 'front' },
    path: string,
    siteName: string,
    status: 200 | 404,
    requestUrl: string,
    preview?: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (!themes?.service.active) return undefined;
    const target: TemplateTarget =
      route.kind === 'content'
        ? { kind: 'single', type: route.content.type, slug: route.content.slug }
        : route.kind === 'front'
          ? { kind: 'front' }
          : { kind: 'not_found' };
    try {
      const template = await themes.service.resolve(target);
      const theme = themes.service.active;
      if (!template || !theme) return undefined;
      let html: string | undefined;
      if (route.kind === 'content' && themes.renderBody) {
        html = await themes.renderBody(route.content);
      } else if (route.kind === 'front') {
        html = String(
          await np.hooks.applyFilters('post:content', '<p>Welcome to your new site.</p>'),
        );
      }
      const posts =
        route.kind === 'front' && themes.latestPosts
          ? await Promise.all(
              (await themes.latestPosts()).map(async (content) => ({
                content,
                url: permalinks ? await permalinks.pathFor(content) : '/',
              })),
            )
          : undefined;
      const tagline = themes.tagline ? await themes.tagline() : '';
      const settings = resolveThemeSettings(theme.manifest.settings, {
        ...(themes.settings ? await themes.settings() : {}),
        ...preview,
      });
      // Menus are optional: a failure here shows the page without them.
      const menus = options.menus
        ? await options.menus.service
            .forLocations(Object.keys(theme.manifest.menus))
            .catch((error: unknown) => {
              np.logger.warn(`Menus could not be loaded for ${path}: ${String(error)}`);
              return {};
            })
        : {};
      // Widgets are optional too: a failure here shows the page without them.
      const widgets = options.widgets
        ? await options.widgets.service
            .forAreas(Object.keys(theme.manifest.widgetAreas))
            .then((areas) =>
              Object.fromEntries(Object.entries(areas).filter(([, list]) => list.length > 0)),
            )
            .catch((error: unknown) => {
              np.logger.warn(`Widgets could not be loaded for ${path}: ${String(error)}`);
              return {};
            })
        : {};
      // The SEO tags are optional too: a failure here shows the page without them.
      const meta = await buildPageMeta(route, path, siteName, status, requestUrl, tagline).catch(
        (error: unknown) => {
          np.logger.warn(`Meta tags could not be built for ${path}: ${String(error)}`);
          return undefined;
        },
      );
      return await renderTemplate(template.component, {
        siteName,
        path,
        status,
        ...(meta ? { meta } : {}),
        ...(route.kind === 'content' ? { content: route.content } : {}),
        ...(html !== undefined ? { html } : {}),
        ...(posts ? { posts } : {}),
        tagline,
        settings,
        menus,
        widgets,
        theme: {
          name: theme.manifest.name,
          version: theme.manifest.version,
          assetsUrl: themeAssetsUrl(theme.manifest.name),
        },
      });
    } catch (error) {
      // A broken template must not take the page down.
      np.logger.warn(`Theme template failed for ${path}: ${String(error)}`);
      return undefined;
    }
  }

  if (options.feeds && permalinks) {
    app.route('/', createFeedRoutes({ ...options.feeds, permalinks }));
  }

  // The front page: drawn by the theme's `front` (or `index`) template; the built-in page below
  // is used when there is no active theme or its template fails.
  app.get('/', async (c) => {
    const siteName = String(np.config.siteName ?? 'NodePress');
    const themed = await renderThemed(
      { kind: 'front' },
      '/',
      siteName,
      200,
      c.req.url,
      await previewOverrides(c),
    );
    if (themed !== undefined) {
      return c.html(await np.hooks.applyFilters('render:html', themed, { path: c.req.path }));
    }
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
      const status = route.kind === 'content' ? (200 as const) : (404 as const);

      const themed = await renderThemed(
        route,
        path,
        siteName,
        status,
        c.req.url,
        await previewOverrides(c),
      );
      if (themed !== undefined) {
        return c.html(await np.hooks.applyFilters('render:html', themed, { path }), status);
      }

      // Built-in markup, used when there is no active theme or its template fails.
      const [title, heading] =
        route.kind === 'content'
          ? [route.content.title, route.content.title]
          : ['Page not found', 'Page not found'];
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
