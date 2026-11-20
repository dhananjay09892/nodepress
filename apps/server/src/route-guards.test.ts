import {
  createApiTokensService,
  createCapabilities,
  createContactForm,
  createContentService,
  createContentTypeRegistry,
  createMenuService,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  createRedirects,
  createSessionsService,
  createSettingsService,
  createTaxonomyService,
  createUsersService,
  createWidgetService,
  silentLogger,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createContactSubmissionsStore,
  createContentMetaStore,
  createContentStore,
  createDatabase,
  createOptionsStore,
  createSessionsStore,
  createSlugRedirectsStore,
  createTaxonomyStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

// A review of every API route, kept as a test: who may call it. The app is built with every
// feature that has routes and each route is called without credentials and as a subscriber (the
// role with the fewest rights). A route someone adds later that forgets its checks fails here.

const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};
const PASSWORD = 'correct horse battery staple';
const BASE = 'http://localhost';

/** Routes anyone may call without signing in. Everything else must answer 401. */
const PUBLIC = new Set([
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/logout',
  'GET /api/v1/openapi.json',
  'GET /api/v1/contact/token',
  'POST /api/v1/contact',
]);

/**
 * Prefixes of features only for people with management rights. A subscriber must not succeed on
 * any route under them (reads included), apart from the routes in `SUBSCRIBER_MAY`.
 */
const MANAGEMENT_PREFIXES = [
  '/api/v1/settings',
  '/api/v1/menus',
  '/api/v1/menu-locations',
  '/api/v1/widgets',
  '/api/v1/redirects',
  '/api/v1/backup',
  '/api/v1/import',
  '/api/v1/contact/submissions',
];

/** Management routes a subscriber may use: none. Kept as a list so an exception is visible. */
const SUBSCRIBER_MAY = new Set<string>([]);

/**
 * Routes where any signed-in user may do harmless or own-account things, so they are not held to
 * "a subscriber must be refused": reading published content, own profile, own tokens, the
 * session itself. Their checks have their own tests (content, users, auth).
 */
const OWN_OR_READ = [
  /^GET \/api\/v1\/content/,
  /^GET \/api\/v1\/taxonomies\//,
  /^\w+ \/api\/v1\/auth\//,
  /^\w+ \/api\/v1\/tokens/,
  /^(GET|PATCH) \/api\/v1\/users\/:id$/,
];

let database: DatabaseHandle;
let app: ReturnType<typeof createApp>;
let subscriberToken: string;
let routes: Array<{ method: string; path: string }>;

beforeAll(async () => {
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  const np = createNodePress({ logger: silentLogger });
  const users = createUsersService({
    store: createUsersStore(database),
    hooks: np.hooks,
    hasher: fakeHasher,
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
  await users.create({ email: 'admin@example.com', password: PASSWORD, role: 'administrator' });
  const subscriber = await users.create({
    email: 'sub@example.com',
    password: PASSWORD,
    role: 'subscriber',
  });
  subscriberToken = (await apiTokens.create(subscriber.id, { name: 'sub' })).token;

  const capabilities = createCapabilities(np.hooks);
  const options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
  const store = createContentStore(database);
  const content = createContentService({ store, hooks: np.hooks });
  const taxonomies = createTaxonomyService({
    store: createTaxonomyStore(database),
    hooks: np.hooks,
  });
  await taxonomies.refresh();
  const settings = createSettingsService({ options });
  const menus = createMenuService({ options });
  const widgets = createWidgetService({
    options,
    hooks: np.hooks,
    getMenu: (id) => menus.get(id),
    recentPosts: async () => [],
  });
  const permalinks = createPermalinkService({
    store,
    redirects: createSlugRedirectsStore(database),
    options,
    hooks: np.hooks,
  });
  const meta = createContentMetaStore(database);
  app = createApp(np, database, {
    auth: { users, sessions, apiTokens },
    permalinks,
    content: {
      service: content,
      types: createContentTypeRegistry({ hooks: np.hooks }),
      capabilities,
      meta,
      taxonomies,
      options,
    },
    users: { service: users, capabilities, sessions },
    settings: { service: settings, capabilities },
    menus: { service: menus, capabilities },
    widgets: { service: widgets, capabilities },
    redirects: { redirects: createRedirects({ options }), capabilities },
    backup: { content, taxonomies, settings, meta, users, capabilities },
    wordpressImport: { content, taxonomies, permalinks, meta, users, capabilities },
    contact: {
      contact: createContactForm({
        store: createContactSubmissionsStore(database),
        secret: 's'.repeat(32),
      }),
      capabilities,
    },
  });

  // Hono keeps every registered handler; the verbs of real routes are what we call.
  const seen = new Set<string>();
  routes = [];
  for (const route of app.routes) {
    if (!route.path.startsWith('/api/v1')) continue;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)) continue;
    const path = route.path.length > 1 ? route.path.replace(/\/+$/, '') : route.path;
    const key = `${route.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: route.method, path });
  }
});

afterAll(async () => {
  await database.close();
});

/** A concrete address for a route pattern, with ids that exist or do not matter. */
function address(path: string): string {
  return (
    BASE +
    path
      .replace(':type', 'post')
      .replace(':taxonomy', 'category')
      .replace(/:[A-Za-z]+/g, '1')
      .replace(/\*/g, 'x')
  );
}

function call(method: string, path: string, headers: Record<string, string> = {}) {
  const writes = method !== 'GET';
  return app.request(address(path), {
    method,
    headers: { ...(writes ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(writes ? { body: '{}' } : {}),
  });
}

describe('API routes: who may call them', () => {
  it('knows the routes of every feature (so this test cannot become empty)', () => {
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(keys.length).toBeGreaterThan(30);
    for (const prefix of [
      '/api/v1/auth',
      '/api/v1/content',
      '/api/v1/users',
      '/api/v1/settings',
      '/api/v1/menus',
      '/api/v1/widgets',
      '/api/v1/redirects',
      '/api/v1/backup',
      '/api/v1/import',
      '/api/v1/contact',
    ]) {
      expect(keys.some((k) => k.split(' ')[1]!.startsWith(prefix))).toBe(true);
    }
  });

  it('asks for a sign-in on every route that is not public', async () => {
    const wrong: string[] = [];
    for (const { method, path } of routes) {
      const key = `${method} ${path}`;
      if (PUBLIC.has(key)) continue;
      const res = await call(method, path);
      if (res.status !== 401) wrong.push(`${key} answered ${res.status} without credentials`);
    }
    expect(wrong).toEqual([]);
  });

  it('refuses a subscriber on every management route', async () => {
    const wrong: string[] = [];
    const headers = { authorization: `Bearer ${subscriberToken}` };
    for (const { method, path } of routes) {
      const key = `${method} ${path}`;
      if (!MANAGEMENT_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
      if (SUBSCRIBER_MAY.has(key)) continue;
      const res = await call(method, path, headers);
      if (res.status !== 403) wrong.push(`${key} answered ${res.status} for a subscriber`);
    }
    expect(wrong).toEqual([]);
  });

  it('never lets a subscriber change anything outside their own account and content rights', async () => {
    const wrong: string[] = [];
    const headers = { authorization: `Bearer ${subscriberToken}` };
    for (const { method, path } of routes) {
      const key = `${method} ${path}`;
      if (method === 'GET' || PUBLIC.has(key)) continue;
      if (OWN_OR_READ.some((rule) => rule.test(key))) continue;
      const res = await call(method, path, headers);
      if (res.status < 400 || res.status >= 500) {
        wrong.push(`${key} answered ${res.status} for a subscriber`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('does not let a subscriber write content, users or terms', async () => {
    const headers = { authorization: `Bearer ${subscriberToken}` };
    for (const [method, path] of [
      ['POST', '/api/v1/content/post'],
      ['PATCH', '/api/v1/content/post/1'],
      ['DELETE', '/api/v1/content/post/1'],
      ['POST', '/api/v1/users'],
      ['DELETE', '/api/v1/users/1'],
      ['POST', '/api/v1/taxonomies/category/terms'],
    ] as const) {
      const res = await call(method, path, headers);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });
});
