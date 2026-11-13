import {
  createApiTokensService,
  createCapabilities,
  createContentService,
  createContentTypeRegistry,
  createNodePress,
  createSessionsService,
  createTaxonomyService,
  createUsersService,
  silentLogger,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createContentMetaStore,
  createContentStore,
  createDatabase,
  createSessionsStore,
  createTaxonomyStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const hasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let database: DatabaseHandle;
let app: ReturnType<typeof createApp>;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  const np = createNodePress({ logger: silentLogger });
  const users = createUsersService({
    store: createUsersStore(database),
    hooks: np.hooks,
    hasher,
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
  for (const role of ['administrator', 'editor', 'author'] as const) {
    const user = await users.create({
      email: `${role}@example.com`,
      password: 'pw-pw-pw-pw-1',
      role,
    });
    tokens[role] = (await apiTokens.create(user.id, { name: role })).token;
  }
  const taxonomies = createTaxonomyService({
    store: createTaxonomyStore(database),
    hooks: np.hooks,
  });
  await taxonomies.refresh();
  app = createApp(np, database, {
    auth: { users, sessions, apiTokens },
    content: {
      service: createContentService({ store: createContentStore(database), hooks: np.hooks }),
      types: createContentTypeRegistry({ hooks: np.hooks }),
      capabilities: createCapabilities(np.hooks),
      meta: createContentMetaStore(database),
      taxonomies,
    },
  });
});

afterEach(async () => {
  await database.close();
});

async function call(method: string, path: string, who: string | null, body?: unknown) {
  const res = await app.request(`http://localhost/api/v1${path}`, {
    method,
    headers: {
      ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json | null };
}

describe('taxonomy routes', () => {
  it('lists the terms of a taxonomy for someone who can manage categories', async () => {
    const made = await call('POST', '/taxonomies/category/terms', 'editor', { name: 'News' });
    expect(made.status).toBe(201);
    const list = await call('GET', '/taxonomies/category/terms', 'editor');
    expect(list.status).toBe(200);
    expect(list.json!.taxonomy).toMatchObject({ name: 'category', hierarchical: true });
    expect(list.json!.terms).toEqual([
      { id: made.json!.term.id, name: 'News', slug: 'news', parentId: null },
    ]);
  });

  it('creates a child category under an existing one', async () => {
    const parent = await call('POST', '/taxonomies/category/terms', 'editor', { name: 'World' });
    const child = await call('POST', '/taxonomies/category/terms', 'editor', {
      name: 'Europe',
      parentId: parent.json!.term.id,
    });
    expect(child.status).toBe(201);
    expect(child.json!.term.parentId).toBe(parent.json!.term.id);
    const missing = await call('POST', '/taxonomies/category/terms', 'editor', {
      name: 'Ghost',
      parentId: 99999,
    });
    expect(missing.status).toBe(400);
  });

  it('returns the existing tag instead of creating a duplicate', async () => {
    const first = await call('POST', '/taxonomies/tag/terms', 'administrator', { name: 'Release' });
    const again = await call('POST', '/taxonomies/tag/terms', 'administrator', { name: 'release' });
    expect(again.json!.term.id).toBe(first.json!.term.id);
    const list = await call('GET', '/taxonomies/tag/terms', 'administrator');
    expect(list.json!.terms).toHaveLength(1);
  });

  it('refuses people without manage_categories, and anonymous requests', async () => {
    expect((await call('GET', '/taxonomies/tag/terms', 'author')).status).toBe(403);
    expect((await call('POST', '/taxonomies/tag/terms', 'author', { name: 'x' })).status).toBe(403);
    expect((await call('GET', '/taxonomies/tag/terms', null)).status).toBe(401);
  });

  it('rejects unknown taxonomies and invalid names', async () => {
    expect((await call('GET', '/taxonomies/nope/terms', 'editor')).status).toBe(404);
    expect((await call('POST', '/taxonomies/nope/terms', 'editor', { name: 'x' })).status).toBe(
      404,
    );
    expect((await call('POST', '/taxonomies/tag/terms', 'editor', {})).status).toBe(400);
    expect((await call('POST', '/taxonomies/tag/terms', 'editor', { name: '   ' })).status).toBe(
      400,
    );
    expect(
      (await call('POST', '/taxonomies/tag/terms', 'editor', { name: 'x'.repeat(500) })).status,
    ).toBe(400);
  });

  it('stores a featured image on posts and pages through the content API', async () => {
    const made = await call('POST', '/content/post', 'editor', {
      title: 'With image',
      meta: { featured_image: 7 },
    });
    expect(made.status).toBe(201);
    expect(made.json!.item.meta).toEqual({ featured_image: 7 });
    const cleared = await call('PATCH', `/content/post/${made.json!.item.id}`, 'editor', {
      meta: { featured_image: null },
    });
    expect(cleared.json!.item.meta).toEqual({});
    const page = await call('POST', '/content/page', 'editor', {
      title: 'Page',
      meta: { featured_image: 'nope' },
    });
    expect(page.status).toBe(400);
  });
});
