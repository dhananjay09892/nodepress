import {
  createContentService,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  silentLogger,
  type ContentService,
} from '@nodepress/core';
import {
  createContentStore,
  createDatabase,
  createOptionsStore,
  createSlugRedirectsStore,
  type DatabaseHandle,
} from '@nodepress/db';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const BASE = 'http://localhost';

let database: DatabaseHandle;
let content: ContentService;
let app: Hono;

beforeEach(async () => {
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  const np = createNodePress({ logger: silentLogger, config: { siteName: 'Test <Site>' } });
  const store = createContentStore(database);
  content = createContentService({ store, hooks: np.hooks });
  const permalinks = createPermalinkService({
    store,
    redirects: createSlugRedirectsStore(database),
    options: createOptionsService({ store: createOptionsStore(database), hooks: np.hooks }),
    hooks: np.hooks,
  });
  permalinks.attach();
  app = createApp(np, database, { permalinks });
});

afterEach(async () => {
  await database.close();
});

describe('front-end resolver', () => {
  it('serves published content at its permalink, escaping text', async () => {
    await content.create({
      type: 'post',
      title: 'Hello <b>World</b>',
      excerpt: 'A & B',
      status: 'published',
    });
    const res = await app.request(`${BASE}/blog/hello-b-world-b`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Hello &lt;b&gt;World&lt;/b&gt;</h1>');
    expect(html).toContain('<p>A &amp; B</p>');
    expect(html).toContain('Test &lt;Site&gt;');
  });

  it('answers 404 with a page for unknown and unpublished paths', async () => {
    await content.create({ type: 'post', title: 'Secret', status: 'draft' });
    for (const path of ['/blog/secret', '/nope', '/blog/%E0%A4%A']) {
      const res = await app.request(`${BASE}${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain('Page not found');
    }
  });

  it('keeps unknown API paths as JSON 404s', async () => {
    const res = await app.request(`${BASE}/api/v1/nothing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect((await app.request(`${BASE}/api/health`)).status).toBe(200);
  });

  it('redirects 301 from an old slug, keeping the query string', async () => {
    const post = await content.create({ type: 'post', title: 'Old name', status: 'published' });
    await content.update(post.id, { slug: 'new-name' });
    const res = await app.request(`${BASE}/blog/old-name?ref=mail`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/blog/new-name?ref=mail');
    expect((await app.request(`${BASE}/blog/new-name`)).status).toBe(200);
  });

  it('is off unless permalinks are configured', async () => {
    const np = createNodePress({ logger: silentLogger });
    const plain = createApp(np, database);
    expect((await plain.request(`${BASE}/blog/anything`)).status).toBe(404);
  });
});
