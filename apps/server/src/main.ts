import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import {
  createApiTokensService,
  createArgon2Hasher,
  createCapabilities,
  createContentService,
  createContentTypeRegistry,
  createLocalStorage,
  createMediaService,
  createJobQueue,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  createScheduledPublisher,
  createMenuService,
  createSettingsService,
  createSharpProcessor,
  createSessionsService,
  createTaxonomyService,
  createThemeService,
  createUsersService,
  discoverThemes,
  createWebhookService,
  createRedirects,
  createContactForm,
  createLogMailAdapter,
  isEmailAddress,
  createDiskPageCache,
  createMemoryPageCache,
  createPageCache,
  createWidgetService,
  cleanIncomingFolders,
  loadPluginPackages,
  PluginStateService,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createContentMetaStore,
  createContentStore,
  createDatabase,
  createJobsStore,
  createMediaStore,
  createOptionsStore,
  createContactSubmissionsStore,
  createPluginsStore,
  createSessionsStore,
  createSlugRedirectsStore,
  createSqlRunner,
  createTaxonomyStore,
  createUsersStore,
} from '@nodepress/db';
import helloPlugin from '@nodepress/plugin-hello';
import seoPlugin from '@nodepress/plugin-seo';
import { createApp } from './app.js';
import { createBodyRenderer } from './body.js';
import { ThemeSettingsService } from './theme-settings.js';

const port = Number(process.env.PORT ?? 3000);

// DATABASE_URL picks the dialect: file:… / libsql://… (SQLite) or postgres://… (PostgreSQL).
const database = createDatabase({
  url: process.env.DATABASE_URL ?? 'file:./nodepress.db',
  ...(process.env.DATABASE_AUTH_TOKEN ? { authToken: process.env.DATABASE_AUTH_TOKEN } : {}),
});

const np = createNodePress({
  config: { siteName: process.env.SITE_NAME ?? 'My NodePress Site' },
  plugins: [helloPlugin, seoPlugin],
});

try {
  await database.migrate();
} catch (error) {
  np.logger.warn(error instanceof Error ? error.message : String(error));
}

// The job queue must exist before plugins activate so they can register jobs in setup().
const jobs = createJobQueue({
  store: createJobsStore(database),
  hooks: np.hooks,
  logger: np.logger.child('jobs'),
});
np.plugins.useJobs(jobs);

// Installed plugin packages (PLUGINS_DIR, default ./plugins-installed) that the site owner turned
// on are registered before boot, so they activate together with the built-in plugins. The options
// service is created here because migrations record what they applied in it.
const options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
const pluginsDir =
  process.env.PLUGINS_DIR ?? fileURLToPath(new URL('../../../plugins-installed', import.meta.url));
const pluginState = new PluginStateService(createPluginsStore(database));
let loadedPackages: string[] = [];
try {
  await cleanIncomingFolders(pluginsDir);
  const loaded = await loadPluginPackages({
    dir: pluginsDir,
    state: pluginState,
    plugins: np.plugins,
    options,
    runner: createSqlRunner(database),
    logger: np.logger.child('plugins'),
  });
  loadedPackages = loaded.registered;
} catch (error) {
  np.logger.error(
    `Plugin packages were not loaded: ${error instanceof Error ? error.message : String(error)}`,
  );
}

await np.boot();

const users = createUsersService({
  store: createUsersStore(database),
  hooks: np.hooks,
  hasher: createArgon2Hasher(),
});
const sessions = createSessionsService({
  store: createSessionsStore(database),
  users,
  hooks: np.hooks,
});

const apiTokens = createApiTokensService({
  store: createApiTokensStore(database),
  users,
  hooks: np.hooks,
});

// Plugin settings pages save their values through the options service.
np.admin.useOptions(options);
const contentStore = createContentStore(database);
const permalinks = createPermalinkService({
  store: contentStore,
  redirects: createSlugRedirectsStore(database),
  options,
  hooks: np.hooks,
  logger: np.logger,
});
// Remembers old slugs whenever content is saved with a new one through the content API.
permalinks.attach();

// Scheduled posts publish themselves when their time comes.
const content = createContentService({
  store: contentStore,
  hooks: np.hooks,
  logger: np.logger.child('content'),
});
// Plugins add content types through a filter; pick them up now that they are activated.
const contentTypes = createContentTypeRegistry({
  hooks: np.hooks,
  logger: np.logger.child('content-types'),
});
await contentTypes.refresh();
// Taxonomies work the same way: built-in `category` and `tag`, plus whatever plugins add.
const taxonomies = createTaxonomyService({
  store: createTaxonomyStore(database),
  hooks: np.hooks,
  logger: np.logger.child('taxonomies'),
});
await taxonomies.refresh();
const scheduledPublisher = createScheduledPublisher({
  content,
  jobs,
  hooks: np.hooks,
  logger: np.logger.child('scheduled-publishing'),
});
scheduledPublisher.attach();
// Webhooks sign each call with a secret derived from WEBHOOK_SIGNING_KEY (32+ characters, kept
// out of the database). Without it the feature stays off rather than storing secrets.
let webhooks: ReturnType<typeof createWebhookService> | undefined;
if (process.env.WEBHOOK_SIGNING_KEY) {
  webhooks = createWebhookService({
    options,
    jobs,
    hooks: np.hooks,
    signingKey: process.env.WEBHOOK_SIGNING_KEY,
    logger: np.logger.child('webhooks'),
    // Only for local development against a receiver on this machine or LAN.
    allowPrivateNetworks: process.env.WEBHOOK_ALLOW_PRIVATE === 'true',
  });
  webhooks.attach();
} else {
  np.logger.info('Webhooks are off: set WEBHOOK_SIGNING_KEY (32+ characters) to enable them.');
}
// Catch scheduled posts that came due while the site was down, then start the runner.
await scheduledPublisher.sweep().catch((error) => np.logger.warn(String(error)));
jobs.start();
const jobPurgeTimer = setInterval(
  () => void jobs.purgeDone().catch((error) => np.logger.warn(String(error))),
  60 * 60 * 1000,
);
jobPurgeTimer.unref();

// Expired sessions are rejected on use; this just keeps the table small.
const purgeTimer = setInterval(
  () => void sessions.purgeExpired().catch((error) => np.logger.warn(String(error))),
  60 * 60 * 1000,
);
purgeTimer.unref();

// Uploaded files live on local disk; MEDIA_DIR moves them (mount a volume there in Docker).
const mediaStorage = createLocalStorage(process.env.MEDIA_DIR ?? './media');
const media = createMediaService({
  store: createMediaStore(database),
  storage: mediaStorage,
  processor: createSharpProcessor(),
  hooks: np.hooks,
  logger: np.logger.child('media'),
  ...(process.env.MAX_UPLOAD_BYTES ? { maxBytes: Number(process.env.MAX_UPLOAD_BYTES) } : {}),
});

// Optional first administrator for development and CI (the installer in Phase 5 replaces this).
// Only used while the site has no users; the password is hashed like any other.
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && (await users.list()).length === 0) {
  await users.create({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    displayName: 'Administrator',
    role: 'administrator',
  });
  np.logger.info(`Created administrator ${process.env.ADMIN_EMAIL}`);
}

// The built admin app is served at /admin; ADMIN_DIR overrides where it is looked up.
const adminDir =
  process.env.ADMIN_DIR ?? fileURLToPath(new URL('../../admin/dist', import.meta.url));
const admin = existsSync(adminDir) ? { dir: adminDir } : undefined;
if (!admin) np.logger.info('Admin app not built (run `pnpm build`); /admin is disabled.');

// Themes live in ./themes (THEMES_DIR moves them); THEME picks the active one. A missing or broken
// theme is logged and the built-in pages are used, so the site stays up.
const themes = createThemeService({ hooks: np.hooks, logger: np.logger.child('themes') });
const themesDir =
  process.env.THEMES_DIR ?? fileURLToPath(new URL('../../../themes', import.meta.url));
const found = await discoverThemes(themesDir);
for (const { dir, message } of found.errors) np.logger.warn(`Theme "${dir}" skipped: ${message}`);
themes.register(found.themes);
const themeName = process.env.THEME ?? 'aurora';
if (themes.activate(themeName)) {
  np.logger.info(`Active theme: ${themeName}`);
} else {
  np.logger.warn(`Theme "${themeName}" is not installed; using the built-in pages.`);
}

// Interim theme settings (the admin customizer comes later): THEME_SETTINGS='{"layout":"business"}'.
// Each key is checked against the theme's `settings` schema, so a bad value falls back to its default.
function readThemeSettings(): Record<string, unknown> {
  const raw = process.env.THEME_SETTINGS;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the warning
  }
  np.logger.warn('THEME_SETTINGS is not a JSON object; using the theme defaults.');
  return {};
}
const themeSettings = readThemeSettings();
const themeSettingsService = new ThemeSettingsService(options);

const capabilities = createCapabilities(np.hooks);
const menuService = createMenuService({ options });
// Widgets: built-in text, menu and recent-posts types plus whatever plugins registered.
const widgetService = createWidgetService({
  options,
  hooks: np.hooks,
  logger: np.logger.child('widgets'),
  getMenu: (id) => menuService.get(id),
  recentPosts: async (limit) =>
    Promise.all(
      (
        await content.list({
          type: 'post',
          status: 'published',
          orderBy: 'publishedAt',
          direction: 'desc',
          limit,
        })
      ).map(async (post) => ({ title: post.title, url: await permalinks.pathFor(post) })),
    ),
});
await widgetService.refresh();
// Anonymous page views are cached. PAGE_CACHE=off turns it off, PAGE_CACHE_DIR keeps pages on disk
// instead of in memory, PAGE_CACHE_TTL_SECONDS sets how long a page may be served (default 600).
// Saving content or changing an option empties the cache.
const pageCacheTtl = Number(process.env.PAGE_CACHE_TTL_SECONDS ?? 600) * 1000;
const pageCache =
  process.env.PAGE_CACHE === 'off'
    ? undefined
    : createPageCache({
        adapter: process.env.PAGE_CACHE_DIR
          ? createDiskPageCache({ dir: process.env.PAGE_CACHE_DIR, ttlMs: pageCacheTtl })
          : createMemoryPageCache({ ttlMs: pageCacheTtl }),
        hooks: np.hooks,
        logger: np.logger.child('page-cache'),
      });
pageCache?.attach();
const contentMeta = createContentMetaStore(database);
const redirects = createRedirects({ options });
const settingsService = createSettingsService({
  options,
  isPublishedPage: async (id) => {
    const page = await content.get(id);
    return page?.type === 'page' && page.status === 'published';
  },
});
// Contact form: CONTACT_TO is where messages are emailed (until a real mail adapter is set up they
// are only logged and kept). CONTACT_SECRET signs the form tokens; without it a random one is used,
// which only means a form loaded before a restart must be loaded again.
const contactTo = process.env.CONTACT_TO;
if (contactTo && !isEmailAddress(contactTo)) {
  np.logger.warn('CONTACT_TO is not a plain email address; contact messages will not be emailed.');
}
const contact = createContactForm({
  store: createContactSubmissionsStore(database),
  secret: process.env.CONTACT_SECRET ?? randomBytes(32).toString('hex'),
  to: contactTo && isEmailAddress(contactTo) ? contactTo : undefined,
  mail: createLogMailAdapter(np.logger.child('mail')),
  logger: np.logger.child('contact'),
});
// Security headers are on by default. CONTENT_SECURITY_POLICY replaces the default policy ("off"
// sends none, for a reverse proxy that sets its own); HSTS=off never sends Strict-Transport-Security.
const cspSetting = process.env.CONTENT_SECURITY_POLICY;
const app = createApp(np, database, {
  security: {
    ...(cspSetting === 'off' ? { csp: false as const } : cspSetting ? { csp: cspSetting } : {}),
    ...(process.env.HSTS === 'off' ? { hsts: false as const } : {}),
    trustProxy: process.env.TRUST_PROXY === 'true',
  },
  ...(admin ? { admin } : {}),
  ...(pageCache ? { pageCache } : {}),
  // SITE_URL (for example https://example.com) is used for absolute links in the sitemap and feed.
  feeds: {
    content,
    siteName: () => String(np.config.siteName ?? 'NodePress'),
    tagline: () => options.get('tagline', ''),
    siteUrl: process.env.SITE_URL,
  },
  permalinks,
  themes: {
    service: themes,
    // Saved customizer values win over THEME_SETTINGS, which only sets starting values.
    settings: async () => ({
      ...themeSettings,
      ...(themes.active
        ? await themeSettingsService.saved(
            themes.active.manifest.name,
            themes.active.manifest.settings,
          )
        : {}),
    }),
    renderBody: createBodyRenderer({ hooks: np.hooks, logger: np.logger.child('render') }),
    tagline: () => options.get('tagline', ''),
    siteUrl: process.env.SITE_URL,
    // The featured image (the id of a media item, kept as a custom field) becomes `og:image`.
    customFields: (item) => contentMeta.getMeta(item.id),
    featuredImage: async (item) => {
      const id = (await contentMeta.getMeta(item.id)).featured_image;
      if (typeof id !== 'number') return undefined;
      const image = await media.get(id);
      return image ? `/${image.path}` : undefined;
    },
    latestPosts: () =>
      content.list({
        type: 'post',
        status: 'published',
        orderBy: 'publishedAt',
        direction: 'desc',
        limit: 10,
      }),
  },
  adminExtensions: { capabilities },
  content: {
    service: content,
    types: contentTypes,
    capabilities,
    meta: contentMeta,
    taxonomies,
    options,
  },
  media: { service: media, storage: mediaStorage, capabilities },
  users: {
    service: users,
    capabilities,
    sessions,
    reassignContent: (fromId, toId) => contentStore.reassignAuthor(fromId, toId),
  },
  settings: { service: settingsService, capabilities },
  backup: {
    content,
    taxonomies,
    settings: settingsService,
    meta: contentMeta,
    users,
    capabilities,
    logger: np.logger.child('backup'),
  },
  menus: { service: menuService, capabilities },
  widgets: { service: widgetService, capabilities },
  themeSettings: { service: themeSettingsService, capabilities },
  ...(webhooks ? { webhooks: { service: webhooks, capabilities } } : {}),
  plugins: {
    dir: pluginsDir,
    state: pluginState,
    capabilities,
    running: () => np.plugins.list(),
    loaded: () => loadedPackages,
  },
  redirects: { redirects, capabilities },
  wordpressImport: {
    content,
    taxonomies,
    permalinks,
    meta: contentMeta,
    users,
    capabilities,
    logger: np.logger.child('import'),
  },
  contact: { contact, capabilities, trustProxy: process.env.TRUST_PROXY === 'true' },
  auth: {
    users,
    sessions,
    apiTokens,
    // Cookies are Secure by default; set COOKIE_SECURE=false only for plain-HTTP local development.
    secureCookies: process.env.COOKIE_SECURE !== 'false',
    trustProxy: process.env.TRUST_PROXY === 'true',
  },
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  np.logger.info(`Listening on http://localhost:${info.port}`);
});

async function stop(signal: string) {
  np.logger.info(`Received ${signal}, shutting down…`);
  clearInterval(purgeTimer);
  clearInterval(jobPurgeTimer);
  await jobs.stop();
  server.close();
  await np.shutdown();
  await database.close();
  process.exit(0);
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
