import {
  createApiTokensService,
  createCapabilities,
  createContentService,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  createRedirects,
  createTaxonomyService,
  createSessionsService,
  createUsersService,
  silentLogger,
  type ContentService,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createContentStore,
  createContentMetaStore,
  createDatabase,
  createOptionsStore,
  createSessionsStore,
  createSlugRedirectsStore,
  createTaxonomyStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};

const PASSWORD = 'correct horse battery staple';
const BASE = 'http://localhost';

let database: DatabaseHandle;
let app: ReturnType<typeof createApp>;
let content: ContentService;

beforeEach(async () => {
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
  for (const [email, role] of [
    ['admin@example.com', 'administrator'],
    ['editor@example.com', 'editor'],
    ['jane@example.com', 'author'],
  ] as const) {
    await users.create({ email, password: PASSWORD, role });
  }
  const taxonomies = createTaxonomyService({
    store: createTaxonomyStore(database),
    hooks: np.hooks,
  });
  await taxonomies.refresh();
  const options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
  const store = createContentStore(database);
  content = createContentService({ store, hooks: np.hooks });
  const permalinks = createPermalinkService({
    store,
    redirects: createSlugRedirectsStore(database),
    options,
    hooks: np.hooks,
  });
  permalinks.attach();
  app = createApp(np, database, {
    auth: { users, sessions, apiTokens },
    permalinks,
    wordpressImport: {
      content,
      taxonomies,
      permalinks,
      meta: createContentMetaStore(database),
      users,
      capabilities: createCapabilities(np.hooks),
    },
    redirects: {
      redirects: createRedirects({ options }),
      capabilities: createCapabilities(np.hooks),
    },
  });
});

afterEach(async () => {
  await database.close();
});

async function signIn(email: string) {
  const res = await app.request(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return {
    cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!,
    'x-csrf-token': csrfToken,
  };
}

const WXR = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>Old Site</title>
  <link>https://old.example.com</link>
  <wp:base_site_url>https://old.example.com</wp:base_site_url>
  <wp:author>
    <wp:author_id>2</wp:author_id>
    <wp:author_login><![CDATA[jane]]></wp:author_login>
    <wp:author_email><![CDATA[jane@example.com]]></wp:author_email>
    <wp:author_display_name><![CDATA[Jane Doe]]></wp:author_display_name>
  </wp:author>
  <item>
    <title>Hello Rome</title>
    <link>https://old.example.com/2024/05/hello-rome/</link>
    <dc:creator><![CDATA[jane]]></dc:creator>
    <content:encoded><![CDATA[<p>Ciao!</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[Ciao]]></excerpt:encoded>
    <wp:post_id>20</wp:post_id>
    <wp:post_date_gmt><![CDATA[2024-05-01 10:00:00]]></wp:post_date_gmt>
    <wp:post_name><![CDATA[hello-rome]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:post_type><![CDATA[post]]></wp:post_type>
  </item>
</channel>
</rss>`;

function importWxr(
  headers: Record<string, string>,
  body: string = WXR,
  query = '',
  type = 'application/xml',
) {
  return app.request(`${BASE}/api/v1/import/wordpress${query}`, {
    method: 'POST',
    headers: { 'content-type': type, ...headers },
    body,
  });
}

type Json = Record<string, unknown>;

describe('GET /api/v1/import/wordpress', () => {
  it('tells administrators the size limit and keeps everyone else out', async () => {
    const url = `${BASE}/api/v1/import/wordpress`;
    expect((await app.request(url)).status).toBe(401);
    const editor = await signIn('editor@example.com');
    expect((await app.request(url, { headers: editor })).status).toBe(403);
    const admin = await signIn('admin@example.com');
    const res = await app.request(url, { headers: admin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ maxBytes: 64 * 1024 * 1024 });
  });
});

describe('POST /api/v1/import/wordpress', () => {
  it('needs a signed-in administrator with the CSRF token', async () => {
    expect((await importWxr({})).status).toBe(401);
    const editor = await signIn('editor@example.com');
    expect((await importWxr(editor)).status).toBe(403);
    const admin = await signIn('admin@example.com');
    expect((await importWxr({ cookie: admin.cookie })).status).toBe(403);
  });

  it('imports, matches the author by email and saves the old URL as a 301 redirect', async () => {
    const admin = await signIn('admin@example.com');
    const res = await importWxr(admin);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const report = (await res.json()) as Json & { redirectsSaved: Json; created: Json };
    expect(report.created).toMatchObject({ posts: 1 });
    expect(report.authorsMatched).toBe(1);
    expect(report.redirectsSaved).toEqual({ created: 1, skipped: [] });

    const posts = await content.list({ type: 'post', status: 'published' });
    expect(posts).toHaveLength(1);
    const jane = (await (
      await app.request(`${BASE}/api/v1/auth/me`, { headers: await signIn('jane@example.com') })
    ).json()) as {
      user: { id: number };
    };
    expect(posts[0]!.authorId).toBe(jane.user.id);

    const page = await app.request(`${BASE}/blog/hello-rome`);
    expect(page.status).toBe(200);
    const old = await app.request(`${BASE}/2024/05/hello-rome`, { redirect: 'manual' });
    expect(old.status).toBe(301);
    expect(old.headers.get('location')).toBe('/blog/hello-rome');
  });

  it('gives everything to the importing user with match_authors=false, or to default_author', async () => {
    const admin = await signIn('admin@example.com');
    const me = (await (await app.request(`${BASE}/api/v1/auth/me`, { headers: admin })).json()) as {
      user: { id: number };
    };
    const res = await importWxr(admin, WXR, '?match_authors=false');
    expect(((await res.json()) as Json).authorsMatched).toBe(0);
    expect((await content.list({ type: 'post' }))[0]!.authorId).toBe(me.user.id);
  });

  it('refuses a bad default_author, other content types and broken XML', async () => {
    const admin = await signIn('admin@example.com');
    expect((await importWxr(admin, WXR, '?default_author=999')).status).toBe(400);
    expect((await importWxr(admin, WXR, '?default_author=abc')).status).toBe(400);
    expect((await importWxr(admin, WXR, '', 'application/json')).status).toBe(415);
    const bad = await importWxr(admin, '<rss><channel>');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_wxr' });
    expect((await importWxr(admin, 'not xml at all')).status).toBe(400);
  });
});
