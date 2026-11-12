import {
  createApiTokensService,
  createCapabilities,
  createContentService,
  createContentTypeRegistry,
  createNodePress,
  createOptionsService,
  createSessionsService,
  createTaxonomyService,
  createUsersService,
  silentLogger,
  type NodePress,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createContentMetaStore,
  createContentStore,
  createDatabase,
  createOptionsStore,
  createSessionsStore,
  createTaxonomyStore,
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
type Extras = Pick<
  NonNullable<NonNullable<Parameters<typeof createApp>[2]>['content']>,
  'meta' | 'taxonomies' | 'options'
>;
let mount: (extra?: Extras) => void;
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
  // `mount` rebuilds the app, so a test can turn on custom fields, terms or public reads.
  mount = (extra) => {
    app = createApp(np, database, {
      auth: { users, sessions, apiTokens },
      content: {
        service: content,
        types,
        capabilities: createCapabilities(np.hooks),
        ...extra,
      },
    });
  };
  mount();
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
      seen.push(`${method} ${route} ${status} ${user?.role}`);
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

describe('revisions', () => {
  it('lists the saved versions of an item, newest first', async () => {
    const post = await make('author', {
      title: 'First',
      body: [{ type: 'core/paragraph', text: 'one' }],
    });
    await call('PATCH', `/content/post/${post.id}`, 'author', { title: 'Second' });
    await call('PATCH', `/content/post/${post.id}`, 'author', { title: 'Third' });
    const res = await call('GET', `/content/post/${post.id}/revisions`, 'author');
    expect(res.status).toBe(200);
    const revisions = res.json!.revisions as Json[];
    // One revision for the creation and one for each change.
    expect(revisions.map((r) => r.snapshot.title)).toEqual(['Third', 'Second', 'First']);
    const ids = revisions.map((r) => r.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(revisions[0]!.contentId).toBe(post.id);
    expect(revisions[0]!.authorId).toBe(ids.author);
    expect(typeof revisions[0]!.createdAt).toBe('string');
  });

  it('is refused without credentials, and for users who cannot edit the item', async () => {
    const post = await make('author', { title: 'Private draft' });
    const path = `/content/post/${post.id}/revisions`;
    expect((await call('GET', path, null)).status).toBe(401);
    expect((await call('GET', path, 'subscriber')).status).toBe(404);
    // Authors cannot read the history of other authors' items; editors can.
    expect((await call('GET', path, 'author2')).status).toBe(404);
    expect((await call('GET', path, 'editor')).status).toBe(200);
    expect((await call('GET', path, 'administrator')).status).toBe(200);
  });

  it('answers 404 for a missing item or unknown type', async () => {
    expect((await call('GET', '/content/post/9999/revisions', 'administrator')).status).toBe(404);
    expect((await call('GET', '/content/nope/1/revisions', 'administrator')).status).toBe(404);
    expect((await call('GET', '/content/post/abc/revisions', 'administrator')).status).toBe(404);
  });

  it('is never readable anonymously, even when public reads are on', async () => {
    const options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
    mount({ options });
    await options.set('api_public_read', true);
    const post = await make('author', { title: 'Live', status: 'published' });
    expect((await call('GET', `/content/post/${post.id}`, null)).status).toBe(200);
    expect((await call('GET', `/content/post/${post.id}/revisions`, null)).status).toBe(401);
  });

  it('can be reshaped by the api:response filter', async () => {
    const post = await make('author');
    np.hooks.addFilter('api:response', (body, ctx) =>
      ctx.route === 'content:revisions' ? { ...(body as object), seen: true } : body,
    );
    expect((await call('GET', `/content/post/${post.id}/revisions`, 'author')).json!.seen).toBe(
      true,
    );
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
      '/api/v1/content/{type}/{id}/revisions',
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

describe('custom fields, terms and public reads', () => {
  let taxonomies: ReturnType<typeof createTaxonomyService>;
  let options: ReturnType<typeof createOptionsService>;
  let meta: ReturnType<typeof createContentMetaStore>;
  const termIds: Record<string, number> = {};

  beforeEach(async () => {
    types.register({
      name: 'product',
      fields: [
        { name: 'price', type: 'number', required: true, min: 0 },
        { name: 'color', type: 'select', options: ['red', 'blue'] },
        { name: 'stock', type: 'number', integer: true, default: 0 },
        { name: 'notes', type: 'text', maxLength: 20 },
      ],
    });
    taxonomies = createTaxonomyService({ store: createTaxonomyStore(database), hooks: np.hooks });
    taxonomies.register({ name: 'genre', contentTypes: ['product'] });
    options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
    meta = createContentMetaStore(database);
    for (const [key, taxonomy, name] of [
      ['news', 'category', 'News'],
      ['travel', 'category', 'Travel'],
      ['fun', 'tag', 'Fun'],
      ['gadget', 'genre', 'Gadget'],
    ] as const) {
      termIds[key] = (await taxonomies.createTerm({ taxonomy, name })).id;
    }
    mount({ meta, taxonomies, options });
  });

  const product = (extra: Json = {}) => ({ title: 'Lamp', meta: { price: 10 }, ...extra });

  describe('custom fields', () => {
    it('stores them on create and returns them, with defaults filled in', async () => {
      const created = await call('POST', '/content/product', 'author', product());
      expect(created.status).toBe(201);
      expect(created.json!.item.meta).toEqual({ price: 10, stock: 0 });
      const id = created.json!.item.id;
      const got = await call('GET', `/content/product/${id}`, 'author');
      expect(got.json!.item.meta).toEqual({ price: 10, stock: 0 });
      expect(got.json!.item.terms).toEqual({ genre: [] });
      expect((await call('GET', `/content/post/${id}`, 'author')).status).toBe(404);
    });

    it('returns them in a list only when asked for', async () => {
      await call(
        'POST',
        '/content/product',
        'author',
        product({ meta: { price: 3, color: 'red' } }),
      );
      const plain = await call('GET', '/content/product?status=draft', 'author');
      expect(plain.json!.items[0]).not.toHaveProperty('meta');
      expect(plain.json!.items[0]).not.toHaveProperty('terms');
      const asked = await call(
        'GET',
        '/content/product?status=draft&fields=title,meta,terms',
        'author',
      );
      expect(Object.keys(asked.json!.items[0]).sort()).toEqual(['meta', 'terms', 'title']);
      expect(asked.json!.items[0].meta).toEqual({ price: 3, color: 'red', stock: 0 });
      expect(asked.json!.items[0].terms).toEqual({ genre: [] });
      const only = await call('GET', '/content/product?status=draft&fields=meta', 'author');
      expect(Object.keys(only.json!.items[0])).toEqual(['meta']);
    });

    it('rejects missing required fields, bad values and unknown fields, saving nothing', async () => {
      const missing = await call('POST', '/content/product', 'author', { title: 'No price' });
      expect(missing.status).toBe(400);
      expect(missing.json!.error).toBe('invalid_request');
      expect(missing.json!.issues.map((i: Json) => i.path)).toEqual(['price']);

      const bad = await call(
        'POST',
        '/content/product',
        'author',
        product({ meta: { price: -1, color: 'green', notes: 'x'.repeat(21), nope: 1 } }),
      );
      expect(bad.status).toBe(400);
      const paths = bad.json!.issues.map((i: Json) => (i.path.length > 0 ? i.path : i.message));
      expect(paths).toEqual(expect.arrayContaining(['price', 'color', 'notes']));
      expect(bad.json!.message).toMatch(/Unknown field: nope/);

      for (const value of [[], 'x', null, 5]) {
        const res = await call('POST', '/content/product', 'author', { title: 'T', meta: value });
        expect([value, res.status]).toEqual([value, 400]);
      }
      const posts = await call('GET', '/content/product?status=draft,published', 'editor');
      expect(posts.json!.total).toBe(0);
    });

    it('does not accept meta for a type with no fields beyond what it declares', async () => {
      const ok = await call('POST', '/content/post', 'author', { title: 'P', meta: {} });
      expect(ok.status).toBe(201);
      expect(ok.json!.item.meta).toEqual({});
      const res = await call('POST', '/content/post', 'author', { title: 'P', meta: { a: 1 } });
      expect(res.status).toBe(400);
    });

    it('updates only the fields that are sent and clears a field with null', async () => {
      const created = await call(
        'POST',
        '/content/product',
        'author',
        product({ meta: { price: 5, color: 'red' } }),
      );
      const id = created.json!.item.id;
      const patch = await call('PATCH', `/content/product/${id}`, 'author', {
        meta: { color: 'blue' },
      });
      expect(patch.status).toBe(200);
      expect(patch.json!.item.meta).toEqual({ price: 5, color: 'blue', stock: 0 });
      expect(patch.json!.item.title).toBe('Lamp');

      const cleared = await call('PATCH', `/content/product/${id}`, 'author', {
        meta: { color: null },
      });
      expect(cleared.json!.item.meta).toEqual({ price: 5, stock: 0 });

      const required = await call('PATCH', `/content/product/${id}`, 'author', {
        meta: { price: null },
      });
      expect(required.status).toBe(400);
      const invalid = await call('PATCH', `/content/product/${id}`, 'author', {
        meta: { price: 'free' },
      });
      expect(invalid.status).toBe(400);
      const unchanged = await call('GET', `/content/product/${id}`, 'author');
      expect(unchanged.json!.item.meta).toEqual({ price: 5, stock: 0 });

      // A bad meta rejects the whole write, including the core fields sent with it.
      const both = await call('PATCH', `/content/product/${id}`, 'author', {
        title: 'Changed',
        meta: { price: -3 },
      });
      expect(both.status).toBe(400);
      expect((await call('GET', `/content/product/${id}`, 'author')).json!.item.title).toBe('Lamp');
    });

    it('never returns values stored under keys the type does not define', async () => {
      const created = await call('POST', '/content/product', 'author', product());
      await meta.setMeta(created.json!.item.id, { internal_secret: 'hidden' });
      const got = await call('GET', `/content/product/${created.json!.item.id}`, 'author');
      expect(got.json!.item.meta).toEqual({ price: 10, stock: 0 });
      expect(JSON.stringify(got.json)).not.toContain('hidden');
    });

    it('follows the same permissions as the item itself', async () => {
      const created = await call('POST', '/content/product', 'author', product());
      const id = created.json!.item.id;
      const other = await call('PATCH', `/content/product/${id}`, 'author2', {
        meta: { price: 1 },
      });
      expect(other.status).toBe(404); // another author's draft is not even visible
      const published = await call('PATCH', `/content/product/${id}`, 'editor', {
        status: 'published',
      });
      expect(published.status).toBe(200);
      const denied = await call('PATCH', `/content/product/${id}`, 'author2', {
        meta: { price: 1 },
      });
      expect(denied.status).toBe(403);
      expect((await call('GET', `/content/product/${id}`, 'editor')).json!.item.meta.price).toBe(
        10,
      );
      const allowed = await call('PATCH', `/content/product/${id}`, 'editor', {
        meta: { price: 12 },
      });
      expect(allowed.json!.item.meta.price).toBe(12);
    });

    it('is removed with the item', async () => {
      const created = await call('POST', '/content/product', 'author', product());
      const id = created.json!.item.id;
      expect((await call('DELETE', `/content/product/${id}?force=true`, 'author')).status).toBe(
        204,
      );
      expect(await meta.getMeta(id)).toEqual({});
    });

    it('is not accepted when the feature is not wired in', async () => {
      mount();
      const res = await call('POST', '/content/product', 'author', product());
      expect(res.status).toBe(400);
      expect(res.json!.message).toMatch(/unknown field: meta/);
      const list = await call('GET', '/content/post?fields=meta', 'author');
      expect(list.status).toBe(400);
    });
  });

  describe('terms', () => {
    it('assigns terms on create and returns them grouped by taxonomy', async () => {
      const created = await call('POST', '/content/post', 'editor', {
        title: 'Hello',
        terms: { category: [termIds.news, termIds.travel, termIds.news], tag: [termIds.fun] },
      });
      expect(created.status).toBe(201);
      expect(created.json!.item.terms).toEqual({
        category: [
          { id: termIds.news, name: 'News', slug: 'news', parentId: null },
          { id: termIds.travel, name: 'Travel', slug: 'travel', parentId: null },
        ],
        tag: [{ id: termIds.fun, name: 'Fun', slug: 'fun', parentId: null }],
      });
      const id = created.json!.item.id;
      const got = await call('GET', `/content/post/${id}`, 'editor');
      expect(got.json!.item.terms.category.map((t: Json) => t.name)).toEqual(['News', 'Travel']);
      const list = await call('GET', '/content/post?fields=id,terms', 'editor');
      expect(list.json!.items[0].terms.tag).toHaveLength(1);
    });

    it('replaces the terms of the taxonomies sent and leaves the others alone', async () => {
      const created = await call('POST', '/content/post', 'editor', {
        title: 'Hello',
        terms: { category: [termIds.news], tag: [termIds.fun] },
      });
      const id = created.json!.item.id;
      const patched = await call('PATCH', `/content/post/${id}`, 'editor', {
        terms: { category: [termIds.travel] },
      });
      expect(patched.status).toBe(200);
      expect(patched.json!.item.terms.category.map((t: Json) => t.name)).toEqual(['Travel']);
      expect(patched.json!.item.terms.tag).toHaveLength(1);
      expect(patched.json!.item.title).toBe('Hello');

      const cleared = await call('PATCH', `/content/post/${id}`, 'editor', { terms: { tag: [] } });
      expect(cleared.json!.item.terms.tag).toEqual([]);
      expect(cleared.json!.item.terms.category).toHaveLength(1);
    });

    it('supports custom taxonomies on the types they allow', async () => {
      const ok = await call(
        'POST',
        '/content/product',
        'editor',
        product({ terms: { genre: [termIds.gadget] } }),
      );
      expect(ok.status).toBe(201);
      expect(ok.json!.item.terms.genre[0].name).toBe('Gadget');
      const wrongType = await call('POST', '/content/post', 'editor', {
        title: 'P',
        terms: { genre: [termIds.gadget] },
      });
      expect(wrongType.status).toBe(400);
      expect(wrongType.json!.message).toMatch(/cannot be used/);
    });

    it('rejects unknown taxonomies, foreign or missing terms and bad shapes, saving nothing', async () => {
      const bodies: Json[] = [
        { terms: { nope: [1] } },
        { terms: { category: [termIds.fun] } },
        { terms: { category: [9999] } },
        { terms: { category: 'news' } },
        { terms: { category: [0] } },
        { terms: { category: [1.5] } },
        { terms: { category: ['1'] } },
        { terms: { category: Array.from({ length: 201 }, (_, i) => i + 1) } },
        { terms: [] },
        { terms: null },
      ];
      for (const body of bodies) {
        const res = await call('POST', '/content/post', 'editor', { title: 'T', ...body });
        expect([body, res.status]).toEqual([body, 400]);
      }
      expect((await call('GET', '/content/post?status=draft', 'editor')).json!.total).toBe(0);
    });

    it('needs the manage_categories capability', async () => {
      const own = await call('POST', '/content/post', 'author', { title: 'Mine' });
      const id = own.json!.item.id;
      const create = await call('POST', '/content/post', 'author', {
        title: 'T',
        terms: { category: [termIds.news] },
      });
      expect(create.status).toBe(403);
      const update = await call('PATCH', `/content/post/${id}`, 'author', {
        terms: { category: [termIds.news] },
      });
      expect(update.status).toBe(403);
      const empty = await call('PATCH', `/content/post/${id}`, 'author', { terms: {} });
      expect(empty.status).toBe(403);
      const item = await call('GET', `/content/post/${id}`, 'author');
      expect(item.json!.item.terms.category).toEqual([]);
      expect((await call('GET', '/content/post?status=draft', 'author')).json!.total).toBe(1);

      const editorOk = await call('PATCH', `/content/post/${id}`, 'editor', {
        terms: { category: [termIds.news] },
      });
      expect(editorOk.status).toBe(200);
      // Plugins can grant the capability.
      np.hooks.addFilter('user:role-capabilities', (caps, { role }) =>
        role === 'author' ? [...caps, 'manage_categories'] : caps,
      );
      const granted = await call('PATCH', `/content/post/${id}`, 'author', {
        terms: { category: [termIds.travel] },
      });
      expect(granted.status).toBe(200);
    });

    it('is not accepted when the feature is not wired in', async () => {
      mount({ meta });
      const res = await call('POST', '/content/post', 'editor', {
        title: 'T',
        terms: { category: [termIds.news] },
      });
      expect(res.status).toBe(400);
      expect(res.json!.message).toMatch(/unknown field: terms/);
    });
  });

  describe('public reads', () => {
    let published: Json;
    let draft: Json;

    beforeEach(async () => {
      published = await make('editor', {
        title: 'Live',
        status: 'published',
        terms: { category: [termIds.news] },
      });
      draft = await make('editor', { title: 'Secret draft' });
      await make('editor', { title: 'Private one', status: 'private' });
      await call('POST', '/content/product', 'editor', product({ status: 'published' }));
    });

    const anon = (path: string, headers: Record<string, string> = {}) =>
      call('GET', path, null, undefined, headers);

    it('are off by default', async () => {
      expect((await anon('/content/post')).status).toBe(401);
      expect((await anon(`/content/post/${published.id}`)).status).toBe(401);
      mount({ meta, taxonomies });
      await options.set('api_public_read', true);
      expect((await anon('/content/post')).status).toBe(401);
    });

    it('stay off when the setting is false or not a boolean', async () => {
      await options.set('api_public_read', false);
      expect((await anon('/content/post')).status).toBe(401);
      await options.set('api_public_read', 'yes' as unknown as boolean);
      expect((await anon('/content/post')).status).toBe(401);
    });

    it('show anonymous visitors published items only, once the setting is on', async () => {
      await options.set('api_public_read', true);
      const list = await anon('/content/post');
      expect(list.status).toBe(200);
      expect(list.res.headers.get('cache-control')).toBe('no-store');
      expect(list.json!.items.map((i: Json) => i.title)).toEqual(['Live']);
      expect(list.json!.total).toBe(1);

      const item = await anon(`/content/post/${published.id}`);
      expect(item.status).toBe(200);
      expect(item.json!.item.terms.category[0].name).toBe('News');
      expect((await anon(`/content/post/${draft.id}`)).status).toBe(404);
      expect((await anon('/content/post/99999')).status).toBe(404);
      expect((await anon('/content/nope')).status).toBe(404);

      const products = await anon('/content/product?fields=title,meta');
      expect(products.json!.items).toEqual([{ title: 'Lamp', meta: { price: 10, stock: 0 } }]);
    });

    it('refuse anonymous requests for other statuses or "me"', async () => {
      await options.set('api_public_read', true);
      expect((await anon('/content/post?status=draft')).status).toBe(403);
      expect((await anon('/content/post?status=published,private')).status).toBe(403);
      expect((await anon('/content/post?status=trash')).status).toBe(403);
      expect((await anon('/content/post?status=published')).status).toBe(200);
      expect((await anon('/content/post?author=me')).status).toBe(400);
      expect((await anon('/content/post?author=abc')).status).toBe(400);
      expect((await anon(`/content/post?author=${ids.editor}`)).json!.total).toBe(1);
    });

    it('never open anything but reading content', async () => {
      await options.set('api_public_read', true);
      const body = { title: 'Nope' };
      expect((await call('POST', '/content/post', null, body)).status).toBe(401);
      expect((await call('PATCH', `/content/post/${published.id}`, null, body)).status).toBe(401);
      expect((await call('DELETE', `/content/post/${published.id}`, null)).status).toBe(401);
      expect((await anon('/content-types')).status).toBe(401);
      const stillThere = await call('GET', `/content/post/${published.id}`, 'editor');
      expect(stillThere.json!.item.status).toBe('published');
    });

    it('still check any credentials that are sent', async () => {
      await options.set('api_public_read', true);
      expect((await anon('/content/post', { authorization: 'Bearer nope' })).status).toBe(401);
      expect((await anon('/content/post', { cookie: '__Host-np_session=nope' })).status).toBe(401);
      // A signed-in user keeps their own view.
      const own = await call('GET', '/content/post?status=draft', 'editor');
      expect(own.json!.items.map((i: Json) => i.title)).toContain('Secret draft');
    });

    it('follow the setting as it changes', async () => {
      await options.set('api_public_read', true);
      expect((await anon('/content/post')).status).toBe(200);
      await options.set('api_public_read', false);
      expect((await anon('/content/post')).status).toBe(401);
    });

    it('run the api:response filter with no user', async () => {
      await options.set('api_public_read', true);
      const seen: unknown[] = [];
      np.hooks.addFilter('api:response', (body, context) => {
        seen.push(context.user);
        return body;
      });
      await anon('/content/post');
      await call('GET', '/content/post', 'editor');
      expect(seen[0]).toBeNull();
      expect(seen[1]).toMatchObject({ id: ids.editor });
    });
  });

  describe('OpenAPI document', () => {
    it('describes custom fields, terms and the public read setting', async () => {
      await options.set('api_public_read', true);
      const res = await call('GET', '/openapi.json', null);
      const doc = res.json!;
      const schemas = doc.components.schemas;
      expect(schemas.ContentMeta_product.required).toEqual(['price']);
      expect(schemas.ContentMeta_product.properties.price).toEqual({
        type: 'number',
        minimum: 0,
      });
      expect(schemas.ContentMeta_product.properties.color).toEqual({
        anyOf: [{ type: 'string', enum: ['red', 'blue'] }, { type: 'null' }],
      });
      expect(schemas.ContentMeta_product.properties.stock.anyOf[0].default).toBe(0);
      expect(schemas.ContentInput.properties.meta.anyOf).toContainEqual({
        $ref: '#/components/schemas/ContentMeta_product',
      });
      expect(Object.keys(schemas.ContentInput.properties.terms.properties).sort()).toEqual([
        'category',
        'genre',
        'tag',
      ]);
      expect(schemas.ContentInput.properties.terms.properties.genre.description).toMatch(/product/);
      expect(schemas.Content.properties.meta).toBeDefined();
      expect(schemas.Content.properties.terms).toBeDefined();
      expect(schemas.Term.required).toContain('slug');
      expect(doc.paths['/api/v1/content/{type}'].get.security).toEqual([{ bearerAuth: [] }, {}]);
      expect(doc.paths['/api/v1/content/{type}/{id}'].get.security).toEqual([
        { bearerAuth: [] },
        {},
      ]);
      expect(doc.paths['/api/v1/content/{type}'].post.security).toEqual([{ bearerAuth: [] }]);
      expect(doc.info.description).toMatch(/setting is on/);

      await options.set('api_public_read', false);
      const off = (await call('GET', '/openapi.json', null)).json!;
      expect(off.paths['/api/v1/content/{type}'].get.security).toEqual([{ bearerAuth: [] }]);
    });

    it('only references schemas that exist', async () => {
      const doc = (await call('GET', '/openapi.json', null)).json!;
      const names = new Set(Object.keys(doc.components.schemas));
      const refs = [...JSON.stringify(doc).matchAll(/#\/components\/schemas\/(\w+)/g)];
      expect(refs.length).toBeGreaterThan(10);
      for (const [, name] of refs) expect(names.has(name!)).toBe(true);
    });

    it('leaves meta and terms out when they are not enabled', () => {
      const doc = createOpenApiDocument(types) as Json;
      expect(doc.components.schemas.Content.properties).not.toHaveProperty('meta');
      expect(doc.components.schemas.Content.properties).not.toHaveProperty('terms');
      expect(doc.components.schemas.ContentInput.properties).not.toHaveProperty('meta');
      expect(doc.components.schemas.ContentInput.properties).not.toHaveProperty('terms');
      expect(doc.components.schemas).not.toHaveProperty('Term');
    });
  });
});
