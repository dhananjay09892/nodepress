import {
  createApiTokensService,
  createCapabilities,
  createContentService,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  createRedirects,
  createSessionsService,
  createUsersService,
  silentLogger,
  type ContentService,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createContentStore,
  createDatabase,
  createOptionsStore,
  createSessionsStore,
  createSlugRedirectsStore,
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
  ] as const) {
    await users.create({ email, password: PASSWORD, role });
  }
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

function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  type = 'application/json',
) {
  return app.request(`${BASE}/api/v1/redirects${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': type }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

type Json = Record<string, unknown>;

describe('/api/v1/redirects permissions', () => {
  it('needs a signed-in administrator', async () => {
    expect((await call('GET', '', {})).status).toBe(401);
    const editor = await signIn('editor@example.com');
    expect((await call('GET', '', editor)).status).toBe(403);
    expect((await call('POST', '', editor, { from: '/a', to: '/b' })).status).toBe(403);
    expect((await call('POST', '/import', editor, 'a,b', 'text/csv')).status).toBe(403);
  });

  it('writes from a session need the CSRF token', async () => {
    const admin = await signIn('admin@example.com');
    const res = await call('POST', '', { cookie: admin.cookie }, { from: '/a', to: '/b' });
    expect(res.status).toBe(403);
  });
});

describe('managing rules', () => {
  it('creates, lists, updates and deletes', async () => {
    const admin = await signIn('admin@example.com');
    const created = await call('POST', '', admin, { from: '/old', to: '/new' });
    expect(created.status).toBe(201);
    const { redirect } = (await created.json()) as { redirect: Json };
    expect(redirect).toMatchObject({ from: '/old', to: '/new', status: 301 });
    const list = (await (await call('GET', '', admin)).json()) as { redirects: Json[] };
    expect(list.redirects).toHaveLength(1);
    const patched = await call('PATCH', `/${redirect.id}`, admin, { status: 302 });
    expect(((await patched.json()) as { redirect: Json }).redirect.status).toBe(302);
    expect((await call('DELETE', `/${redirect.id}`, admin)).status).toBe(204);
    expect((await call('DELETE', `/${redirect.id}`, admin)).status).toBe(404);
    expect((await call('PATCH', '/abc', admin, { to: '/x' })).status).toBe(404);
  });

  it('answers 400 with the field for bad input', async () => {
    const admin = await signIn('admin@example.com');
    const bad = await call('POST', '', admin, { from: 'old', to: '/new' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_request', field: 'from' });
    await call('POST', '', admin, { from: '/a', to: '/b' });
    const dup = await call('POST', '', admin, { from: '/a', to: '/c' });
    expect(await dup.json()).toMatchObject({ field: 'from' });
    const loop = await call('POST', '', admin, { from: '/b', to: '/a' });
    expect(await loop.json()).toMatchObject({ field: 'to' });
    expect((await call('POST', '', admin, 'not json')).status).toBe(400);
  });
});

describe('CSV import', () => {
  it('imports good rows and reports bad lines', async () => {
    const admin = await signIn('admin@example.com');
    const res = await call(
      'POST',
      '/import',
      admin,
      'from,to,status\n/a,/b\n/c,/d,302\nbad,/x\n',
      'text/csv',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      created: 2,
      updated: 0,
      errors: [{ line: 4, message: expect.any(String) }],
    });
    const list = (await (await call('GET', '', admin)).json()) as { redirects: Json[] };
    expect(list.redirects.map((r) => r.from)).toEqual(['/a', '/c']);
  });

  it('refuses other content types, oversized files and broken CSV', async () => {
    const admin = await signIn('admin@example.com');
    expect((await call('POST', '/import', admin, '{}', 'application/json')).status).toBe(415);
    expect(
      (await call('POST', '/import', admin, 'x'.repeat(1024 * 1024 + 1), 'text/csv')).status,
    ).toBe(413);
    const broken = await call('POST', '/import', admin, '"open', 'text/csv');
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ field: 'csv' });
  });
});

describe('on the site', () => {
  async function addRule(from: string, to: string, status?: number) {
    const admin = await signIn('admin@example.com');
    await call('POST', '', admin, { from, to, ...(status ? { status } : {}) });
  }

  it('redirects a path with a rule, keeping 301 or 302', async () => {
    await addRule('/old-page', '/new-page');
    await addRule('/promo', 'https://example.com/sale', 302);
    const permanent = await app.request(`${BASE}/old-page`, { redirect: 'manual' });
    expect(permanent.status).toBe(301);
    expect(permanent.headers.get('location')).toBe('/new-page');
    const temporary = await app.request(`${BASE}/promo`, { redirect: 'manual' });
    expect(temporary.status).toBe(302);
    expect(temporary.headers.get('location')).toBe('https://example.com/sale');
  });

  it('wildcards map the rest of the path', async () => {
    await addRule('/blog/*', '/news/*');
    const res = await app.request(`${BASE}/blog/2020/hello`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/news/2020/hello');
  });

  it('a real page at the same path wins over a rule', async () => {
    await content.create({ type: 'page', title: 'Contact', slug: 'contact', status: 'published' });
    await addRule('/contact', '/somewhere-else');
    const res = await app.request(`${BASE}/contact`, { redirect: 'manual' });
    expect(res.status).toBe(200);
  });

  it('paths without a rule are still 404, and rules cannot catch API paths', async () => {
    await addRule('/old-page', '/new-page');
    expect((await app.request(`${BASE}/nothing-here`)).status).toBe(404);
    const admin = await signIn('admin@example.com');
    const res = await call('POST', '', admin, { from: '/api/v1/users', to: '/x' });
    expect(res.status).toBe(400);
  });
});
