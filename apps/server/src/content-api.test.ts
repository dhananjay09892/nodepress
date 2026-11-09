import {
  createApiTokensService,
  createCapabilities,
  createContentService,
  createContentTypeRegistry,
  createNodePress,
  createSessionsService,
  createUsersService,
  silentLogger,
  type NodePress,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createContentStore,
  createDatabase,
  createSessionsStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createOpenApiDocument } from './content-api.js';

const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};

const PASSWORD = 'correct horse battery staple';
const BASE = 'http://localhost';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let database: DatabaseHandle;
let np: NodePress;
let app: ReturnType<typeof createApp>;
let types: ReturnType<typeof createContentTypeRegistry>;
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};

beforeEach(async () => {
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  np = createNodePress({ logger: silentLogger });
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
  for (const role of ['administrator', 'editor', 'author', 'contributor', 'subscriber'] as const) {
    const user = await users.create({ email: `${role}@example.com`, password: PASSWORD, role });
    ids[role] = user.id;
    tokens[role] = (await apiTokens.create(user.id, { name: role })).token;
  }
  const other = await users.create({
    email: 'author2@example.com',
    password: PASSWORD,
    role: 'author',
  });
  ids.author2 = other.id;
  tokens.author2 = (await apiTokens.create(other.id, { name: 'author2' })).token;

  types = createContentTypeRegistry({ hooks: np.hooks });
  const content = createContentService({
    store: createContentStore(database),
    hooks: np.hooks,
  });
  app = createApp(np, database, {
    auth: { users, sessions, apiTokens },
    content: { service: content, types, capabilities: createCapabilities(np.hooks) },
  });
});

afterEach(async () => {
  await database.close();
});

async function call(
  method: string,
  path: string,
  who: string | null,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await app.request(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json | null, res };
}

async function make(who: string, body: Json = {}, type = 'post'): Promise<Json> {
  const { status, json } = await call('POST', `/content/${type}`, who, {
    title: 'Untitled',
    ...body,
  });
  expect(status).toBe(201);
  return json!.item as Json;
}

describe('authentication', () => {
  it('requires credentials for every content route', async () => {
    for (const [method, path] of [
      ['GET', '/content-types'],
      ['GET', '/content/post'],
      ['GET', '/content/post/1'],
      ['POST', '/content/post'],
      ['PATCH', '/content/post/1'],
      ['DELETE', '/content/post/1'],
    ] as const) {
      expect((await call(method, path, null, method === 'GET' ? undefined : {})).status).toBe(401);
    }
    const bad = await call('GET', '/content/post', null, undefined, {
      authorization: 'Bearer nope',
    });
    expect(bad.status).toBe(401);
  });

  it('requires a CSRF token for session writes and rejects other origins', async () => {
    const login = await app.request(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'author@example.com', password: PASSWORD }),
    });
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const write = (headers: Record<string, string>) =>
      call('POST', '/content/post', null, { title: 'x' }, { cookie, ...headers });
    expect((await write({})).status).toBe(403);
    expect(
      (await write({ 'x-csrf-token': csrfToken, origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await write({ 'x-csrf-token': csrfToken })).status).toBe(201);
    expect((await call('GET', '/content/post', null, undefined, { cookie })).status).toBe(200);
  });

  it('never caches responses', async () => {
    const { res } = await call('GET', '/content/post', 'author');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('create, read, update, delete', () => {
  it('runs the whole life of an item', async () => {
    const created = await make('author', {
      title: 'Hello World',
      body: [{ type: 'paragraph', text: 'Hi' }],
      excerpt: 'Short',
    });
    expect(created).toMatchObject({
      type: 'post',
      status: 'draft',
      title: 'Hello World',
      slug: 'hello-world',
      excerpt: 'Short',
      authorId: ids.author,
      parentId: null,
      publishedAt: null,
    });
    expect(created.body).toEqual([{ type: 'paragraph', text: 'Hi' }]);
    expect(typeof created.createdAt).toBe('string');

    const got = await call('GET', `/content/post/${created.id}`, 'author');
    expect(got.status).toBe(200);
    expect(got.json!.item).toEqual(created);

    const patched = await call('PATCH', `/content/post/${created.id}`, 'author', {
      title: 'Renamed',
      excerpt: null,
    });
    expect(patched.status).toBe(200);
    expect(patched.json!.item).toMatchObject({
      title: 'Renamed',
      slug: 'hello-world',
      excerpt: null,
    });

    const trashed = await call('DELETE', `/content/post/${created.id}`, 'author');
    expect(trashed.status).toBe(200);
    expect(trashed.json!.item.status).toBe('trash');
    expect((await call('GET', `/content/post/${created.id}`, 'author')).status).toBe(200);

    const restored = await call('PATCH', `/content/post/${created.id}`, 'author', {
      status: 'draft',
    });
    expect(restored.json!.item.status).toBe('draft');
    expect((await call('DELETE', `/content/post/${created.id}`, 'author')).status).toBe(200);
    expect((await call('DELETE', `/content/post/${created.id}`, 'author')).status).toBe(204);
    expect((await call('GET', `/content/post/${created.id}`, 'author')).status).toBe(404);
  });

  it('deletes permanently with force=true', async () => {
    const item = await make('author');
    expect((await call('DELETE', `/content/post/${item.id}?force=true`, 'author')).status).toBe(
      204,
    );
    expect((await call('GET', `/content/post/${item.id}`, 'administrator')).status).toBe(404);
  });

  it('publishes and schedules', async () => {
    const item = await make('author', { title: 'News', status: 'published' });
    expect(item.status).toBe('published');
    expect(typeof item.publishedAt).toBe('string');
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await call('POST', '/content/post', 'author', {
      title: 'Later',
      status: 'scheduled',
      publishedAt: future,
    });
    expect(scheduled.json!.item).toMatchObject({ status: 'scheduled', publishedAt: future });
  });

  it('serves pages and custom types, and keeps types apart', async () => {
    types.register({ name: 'product', labelPlural: 'Products' });
    const product = await make('administrator', { title: 'Widget' }, 'product');
    expect(product.type).toBe('product');
    expect((await call('GET', `/content/post/${product.id}`, 'administrator')).status).toBe(404);
    expect((await call('GET', `/content/product/${product.id}`, 'administrator')).status).toBe(200);
    const page = await make('administrator', { title: 'About' }, 'page');
    expect(page.type).toBe('page');
    expect((await call('GET', '/content/nope', 'administrator')).json).toEqual({
      error: 'unknown_content_type',
    });
    expect((await call('POST', '/content/nope', 'administrator', {})).status).toBe(404);
    expect(
      (await call('GET', '/content-types', 'author')).json!.types.map((t: Json) => t.name),
    ).toEqual(['post', 'page', 'product']);
  });

  it('answers 404 for bad ids', async () => {
    for (const id of ['0', '-1', 'abc', '1.5', '99999999999999999999', '999']) {
      expect((await call('GET', `/content/post/${id}`, 'administrator')).status).toBe(404);
      expect((await call('PATCH', `/content/post/${id}`, 'administrator', {})).status).toBe(404);
      expect((await call('DELETE', `/content/post/${id}`, 'administrator')).status).toBe(404);
    }
  });
});

describe('request validation', () => {
  it('rejects malformed bodies', async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      call('POST', '/content/post', 'author', body, headers);
    expect((await post('{nope')).json).toEqual({ error: 'invalid_json' });
    expect((await post('[]')).status).toBe(400);
    expect((await post('null')).status).toBe(400);
    expect((await post({ title: 5 })).status).toBe(400);
    expect((await post({ slug: 5 })).status).toBe(400);
    expect((await post({ body: 'text' })).status).toBe(400);
    expect((await post({ excerpt: 5 })).status).toBe(400);
    expect((await post({ authorId: 'x' })).status).toBe(400);
    expect((await post({ authorId: 0 })).status).toBe(400);
    expect((await post({ parentId: 1.5 })).status).toBe(400);
    expect((await post({ publishedAt: 'yesterday-ish' })).status).toBe(400);
    expect((await post({ publishedAt: 5 })).status).toBe(400);
    expect((await post({ status: 'nope' })).status).toBe(400);
    expect((await post({ title: 'x'.repeat(501) })).status).toBe(400);
    expect((await post({ body: [{ nope: true }] })).status).toBe(400);
    const textual = await call('POST', '/content/post', 'author', 'title=x', {
      'content-type': 'text/plain',
    });
    expect(textual.status).toBe(415);
  });

  it('rejects unknown fields so nothing is set by accident', async () => {
    const res = await call('POST', '/content/post', 'administrator', {
      title: 'x',
      id: 99,
      type: 'page',
    });
    expect(res.status).toBe(400);
    expect(res.json!.message).toContain('id');
    const item = await make('administrator');
    expect(
      (
        await call('PATCH', `/content/post/${item.id}`, 'administrator', {
          createdAt: '2020-01-01',
        })
      ).status,
    ).toBe(400);
  });

  it('sends trashing through DELETE', async () => {
    const item = await make('author');
    const res = await call('PATCH', `/content/post/${item.id}`, 'author', { status: 'trash' });
    expect(res.status).toBe(400);
    expect(res.json!.message).toContain('DELETE');
  });

  it('limits the body size', async () => {
    const big = JSON.stringify({ title: 'x', excerpt: 'y'.repeat(1024 * 1024 + 1) });
    expect((await call('POST', '/content/post', 'author', big)).status).toBe(413);
  });

  it('passes service validation errors through as 400', async () => {
    const res = await call('POST', '/content/post', 'author', {
      status: 'scheduled',
      publishedAt: '2001-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(res.json!.error).toBe('invalid_request');
    const parent = await call('POST', '/content/post', 'author', { parentId: 12345 });
    expect(parent.status).toBe(400);
  });
});

describe('permissions', () => {
  it('lets subscribers read but never write', async () => {
    const published = await make('author', { status: 'published' });
    expect((await call('GET', `/content/post/${published.id}`, 'subscriber')).status).toBe(200);
    expect((await call('GET', '/content/post', 'subscriber')).status).toBe(200);
    expect((await call('POST', '/content/post', 'subscriber', { title: 'x' })).status).toBe(403);
    expect(
      (await call('PATCH', `/content/post/${published.id}`, 'subscriber', { title: 'x' })).status,
    ).toBe(403);
    expect((await call('DELETE', `/content/post/${published.id}`, 'subscriber')).status).toBe(403);
  });

  it('lets contributors write drafts only', async () => {
    expect(
      (await call('POST', '/content/post', 'contributor', { status: 'published' })).status,
    ).toBe(403);
    expect((await call('POST', '/content/post', 'contributor', { status: 'private' })).status).toBe(
      403,
    );
    const draft = await make('contributor', { title: 'Mine' });
    const edit = await call('PATCH', `/content/post/${draft.id}`, 'contributor', {
      title: 'Mine 2',
    });
    expect(edit.status).toBe(200);
    expect(
      (await call('PATCH', `/content/post/${draft.id}`, 'contributor', { status: 'published' }))
        .status,
    ).toBe(403);
    // once an editor publishes it, the contributor cannot touch it any more
    await call('PATCH', `/content/post/${draft.id}`, 'editor', { status: 'published' });
    expect(
      (await call('PATCH', `/content/post/${draft.id}`, 'contributor', { title: 'again' })).status,
    ).toBe(403);
    expect((await call('DELETE', `/content/post/${draft.id}`, 'contributor')).status).toBe(403);
  });

  it('keeps authors to their own items', async () => {
    const mine = await make('author', { status: 'published' });
    const theirs = await make('author2', { title: 'Theirs', status: 'published' });
    const theirDraft = await make('author2', { title: 'Their draft' });
    expect(
      (await call('PATCH', `/content/post/${mine.id}`, 'author', { title: 'ok' })).status,
    ).toBe(200);
    // visible but not editable: 403. Someone else's draft is invisible: 404.
    expect(
      (await call('PATCH', `/content/post/${theirs.id}`, 'author', { title: 'no' })).status,
    ).toBe(403);
    expect((await call('DELETE', `/content/post/${theirs.id}`, 'author')).status).toBe(403);
    expect((await call('GET', `/content/post/${theirDraft.id}`, 'author')).status).toBe(404);
    expect(
      (await call('PATCH', `/content/post/${theirDraft.id}`, 'author', { title: 'no' })).status,
    ).toBe(404);
    expect((await call('DELETE', `/content/post/${theirDraft.id}`, 'author')).status).toBe(404);
    // and cannot hand items to others or write as someone else
    expect((await call('POST', '/content/post', 'author', { authorId: ids.author2 })).status).toBe(
      403,
    );
    expect(
      (await call('PATCH', `/content/post/${mine.id}`, 'author', { authorId: ids.author2 })).status,
    ).toBe(403);
    expect((await call('POST', '/content/post', 'author', { authorId: ids.author })).status).toBe(
      201,
    );
  });

  it("lets editors and administrators manage everyone's items", async () => {
    const draft = await make('author', { title: 'Draft' });
    expect((await call('GET', `/content/post/${draft.id}`, 'editor')).status).toBe(200);
    const edited = await call('PATCH', `/content/post/${draft.id}`, 'editor', {
      status: 'published',
      authorId: ids.author2,
    });
    expect(edited.json!.item).toMatchObject({ status: 'published', authorId: ids.author2 });
    expect((await call('DELETE', `/content/post/${draft.id}`, 'administrator')).status).toBe(200);
  });

  it('guards pages with the page capabilities', async () => {
    expect((await call('POST', '/content/page', 'author', { title: 'x' })).status).toBe(403);
    expect((await call('POST', '/content/page', 'contributor', { title: 'x' })).status).toBe(403);
    const page = await make('editor', { title: 'About', status: 'published' }, 'page');
    expect((await call('PATCH', `/content/page/${page.id}`, 'author', { title: 'x' })).status).toBe(
      403,
    );
    expect((await call('GET', `/content/page/${page.id}`, 'author')).status).toBe(200);
  });

  it('hides private items from people who cannot read private content', async () => {
    const secret = await make('editor', { title: 'Secret', status: 'private' });
    expect((await call('GET', `/content/post/${secret.id}`, 'author')).status).toBe(404);
    expect((await call('GET', `/content/post/${secret.id}`, 'editor')).status).toBe(200);
    expect((await call('GET', `/content/post/${secret.id}`, 'subscriber')).status).toBe(404);
  });

  it('follows capabilities that plugins add or remove', async () => {
    np.hooks.addFilter('user:role-capabilities', (list, { role }) =>
      role === 'subscriber' ? [...list, 'edit_posts'] : list,
    );
    expect(
      (await call('POST', '/content/post', 'subscriber', { title: 'now allowed' })).status,
    ).toBe(201);
    np.hooks.addFilter('user:can', (value, { capability }) =>
      capability === 'read' ? false : value,
    );
    expect((await call('GET', '/content/post', 'author')).status).toBe(403);
  });
});

describe('listing', () => {
  async function seed() {
    await make('author', { title: 'Banana', status: 'published' });
    await make('author', { title: 'Apple', status: 'published' });
    await make('author2', { title: 'Cherry', status: 'published' });
    await make('author', { title: 'Mine draft' });
    await make('author2', { title: 'Their draft' });
  }
  const titles = (json: Json | null) => json!.items.map((i: Json) => i.title);

  it('pages through results and reports the total', async () => {
    await seed();
    const first = await call('GET', '/content/post?limit=2', 'editor');
    expect(first.json).toMatchObject({ total: 5, limit: 2, offset: 0 });
    expect(titles(first.json)).toEqual(['Their draft', 'Mine draft']);
    const next = await call('GET', '/content/post?limit=2&offset=2', 'editor');
    expect(titles(next.json)).toEqual(['Cherry', 'Apple']);
    const defaults = await call('GET', '/content/post', 'editor');
    expect(defaults.json).toMatchObject({ total: 5, limit: 20, offset: 0 });
  });

  it('sorts, searches and finds by slug', async () => {
    await seed();
    expect(
      titles((await call('GET', '/content/post?sort=title&status=published', 'editor')).json),
    ).toEqual(['Apple', 'Banana', 'Cherry']);
    expect(
      titles((await call('GET', '/content/post?sort=-title&status=published', 'editor')).json),
    ).toEqual(['Cherry', 'Banana', 'Apple']);
    expect(
      titles((await call('GET', '/content/post?sort=id&status=published', 'editor')).json),
    ).toEqual(['Banana', 'Apple', 'Cherry']);
    const search = await call('GET', '/content/post?q=AN', 'editor');
    expect(titles(search.json)).toEqual(['Banana']);
    expect(search.json!.total).toBe(1);
    expect(titles((await call('GET', '/content/post?slug=cherry', 'editor')).json)).toEqual([
      'Cherry',
    ]);
    expect((await call('GET', '/content/post?q=%25', 'editor')).json!.total).toBe(0);
  });

  it('selects fields', async () => {
    await seed();
    const list = await call('GET', '/content/post?fields=id,title&limit=1', 'editor');
    expect(Object.keys(list.json!.items[0]).sort()).toEqual(['id', 'title']);
    const item = await call('GET', `/content/post/${list.json!.items[0].id}?fields=slug`, 'editor');
    expect(Object.keys(item.json!.item)).toEqual(['slug']);
  });

  it('shows ordinary users published items, and their own drafts on request', async () => {
    await seed();
    expect(titles((await call('GET', '/content/post', 'author')).json).sort()).toEqual([
      'Apple',
      'Banana',
      'Cherry',
    ]);
    const mine = await call('GET', '/content/post?status=draft', 'author');
    expect(titles(mine.json)).toEqual(['Mine draft']);
    const all = await call('GET', '/content/post?status=draft,published', 'author');
    expect(all.json!.total).toBe(3); // only their own: two published and one draft
    expect(titles(all.json)).toEqual(['Mine draft', 'Apple', 'Banana']);
    expect(
      (await call('GET', `/content/post?status=draft&author=${ids.author2}`, 'author')).status,
    ).toBe(403);
    expect(
      (await call('GET', `/content/post?status=draft&author=${ids.author}`, 'author')).status,
    ).toBe(200);
    expect((await call('GET', '/content/post?status=draft&author=me', 'author')).json!.total).toBe(
      1,
    );
    const theirs = await call('GET', `/content/post?author=${ids.author2}`, 'author');
    expect(titles(theirs.json)).toEqual(['Cherry']);
    expect((await call('GET', '/content/post?status=private', 'author')).json!.total).toBe(0);
  });

  it('shows trash only when asked', async () => {
    await seed();
    const item = await make('author', { title: 'Gone' });
    await call('DELETE', `/content/post/${item.id}`, 'author');
    expect((await call('GET', '/content/post', 'editor')).json!.total).toBe(5);
    expect(titles((await call('GET', '/content/post?status=trash', 'editor')).json)).toEqual([
      'Gone',
    ]);
    expect(titles((await call('GET', '/content/post?status=trash', 'author')).json)).toEqual([
      'Gone',
    ]);
    expect((await call('GET', '/content/post?status=trash', 'author2')).json!.total).toBe(0);
  });

  it('rejects bad query parameters', async () => {
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=abc',
      'limit=-1',
      'offset=-1',
      'offset=1.5',
      'sort=body',
      'sort=--id',
      'fields=id,secret',
      'fields=',
      'status=nope',
      'status=',
      'author=abc',
      'author=0',
      `q=${'x'.repeat(201)}`,
    ]) {
      const res = await call('GET', `/content/post?${query}`, 'editor');
      expect([query, res.status]).toEqual([query, 400]);
    }
  });
});

describe('api:response filter', () => {
  it('lets plugins change successful responses', async () => {
    const seen: string[] = [];
    np.hooks.addFilter('api:response', (body, { route, method, status, user }) => {
      seen.push(`${method} ${route} ${status} ${user.role}`);
      return { ...(body as object), meta: { route } };
    });
    const created = await call('POST', '/content/post', 'author', { title: 'x' });
    expect(created.json!.meta).toEqual({ route: 'content:create' });
    const list = await call('GET', '/content/post', 'author');
    expect(list.json!.meta).toEqual({ route: 'content:list' });
    await call('GET', '/content-types', 'author');
    expect(seen).toEqual([
      'POST content:create 201 author',
      'GET content:list 200 author',
      'GET content-types:list 200 author',
    ]);
  });

  it('survives listeners that fail or return nonsense, and skips errors', async () => {
    np.hooks.addFilter('api:response', () => {
      throw new Error('boom');
    });
    np.hooks.addFilter('api:response', () => 'not an object', { priority: 20 });
    np.hooks.addFilter('api:response', () => [1, 2, 3], { priority: 30 });
    const list = await call('GET', '/content/post', 'author');
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ items: [], total: 0 });
    let calls = 0;
    np.hooks.addFilter('api:response', (body) => {
      calls++;
      return body;
    });
    expect((await call('GET', '/content/post/999', 'author')).status).toBe(404);
    expect((await call('POST', '/content/post', 'author', { title: 5 })).status).toBe(400);
    expect(calls).toBe(0);
  });
});

describe('OpenAPI document', () => {
  it('is public and describes every route and the registered types', async () => {
    types.register({ name: 'product' });
    const res = await call('GET', '/openapi.json', null);
    expect(res.status).toBe(200);
    const doc = res.json!;
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/v1/content-types',
      '/api/v1/content/{type}',
      '/api/v1/content/{type}/{id}',
    ]);
    expect(Object.keys(doc.paths['/api/v1/content/{type}'])).toEqual(['get', 'post']);
    expect(Object.keys(doc.paths['/api/v1/content/{type}/{id}'])).toEqual([
      'get',
      'patch',
      'delete',
    ]);
    expect(doc.paths['/api/v1/content/{type}'].get.parameters[0].schema.enum).toEqual([
      'post',
      'page',
      'product',
    ]);
    expect(doc.components.schemas.ContentInput.additionalProperties).toBe(false);
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
  });

  it('only references schemas that exist', () => {
    const document = createOpenApiDocument(types) as Json;
    const names = new Set(Object.keys(document.components.schemas));
    const refs = [...JSON.stringify(document).matchAll(/#\/components\/schemas\/(\w+)/g)];
    expect(refs.length).toBeGreaterThan(5);
    for (const [, name] of refs) expect(names.has(name!)).toBe(true);
  });

  it('documents every query parameter the list route reads', () => {
    const doc = createOpenApiDocument(types) as Json;
    const names = doc.paths['/api/v1/content/{type}'].get.parameters.map((p: Json) => p.name);
    expect(names).toEqual([
      'type',
      'status',
      'author',
      'slug',
      'q',
      'sort',
      'limit',
      'offset',
      'fields',
    ]);
  });
});
