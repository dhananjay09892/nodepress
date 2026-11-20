import {
  createContentService,
  createMemoryPageCache,
  createNodePress,
  createOptionsService,
  createPageCache,
  createPermalinkService,
  silentLogger,
  type ContentService,
  type NodePress,
  type PageCache,
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
let np: NodePress;
let content: ContentService;
let cache: PageCache;
let app: Hono;

beforeEach(async () => {
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  np = createNodePress({ logger: silentLogger, config: { siteName: 'Cached Site' } });
  const store = createContentStore(database);
  content = createContentService({ store, hooks: np.hooks });
  const options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
  const permalinks = createPermalinkService({
    store,
    redirects: createSlugRedirectsStore(database),
    options,
    hooks: np.hooks,
  });
  permalinks.attach();
  cache = createPageCache({ adapter: createMemoryPageCache(), hooks: np.hooks });
  cache.attach();
  app = createApp(np, database, { permalinks, pageCache: cache });
});

afterEach(async () => {
  await database.close();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`${BASE}${path}`, { headers });

describe('page cache', () => {
  it('renders once, then serves the same page from the cache', async () => {
    const first = await get('/');
    expect(first.status).toBe(200);
    expect(first.headers.get('x-nodepress-cache')).toBe('miss');
    const second = await get('/');
    expect(second.headers.get('x-nodepress-cache')).toBe('hit');
    expect(second.headers.get('content-type')).toContain('text/html');
    expect(await second.text()).toBe(await first.text());
    expect([cache.hits, cache.misses]).toEqual([1, 1]);
  });

  it('caches content pages and is purged when content is published or changed', async () => {
    await content.create({ type: 'post', title: 'Hello', status: 'published' });
    expect((await get('/blog/hello')).headers.get('x-nodepress-cache')).toBe('miss');
    expect((await get('/blog/hello')).headers.get('x-nodepress-cache')).toBe('hit');

    const post = (await content.list({ type: 'post' }))[0]!;
    await content.update(post.id, { title: 'Hello again' });
    const after = await get('/blog/hello');
    expect(after.headers.get('x-nodepress-cache')).toBe('miss');
    expect(await after.text()).toContain('Hello again');
  });

  it('is purged when an option changes', async () => {
    await get('/');
    expect((await get('/')).headers.get('x-nodepress-cache')).toBe('hit');
    await np.hooks.doAction('option:updated', 'site_title', 'New', 'Old');
    expect((await get('/')).headers.get('x-nodepress-cache')).toBe('miss');
  });

  it('does not cache 404s, query strings, other methods, signed-in or token requests', async () => {
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/nope')).headers.get('x-nodepress-cache')).toBeNull();

    await get('/?utm=1');
    expect((await get('/?utm=1')).headers.get('x-nodepress-cache')).toBeNull();

    await get('/');
    const post = await app.request(`${BASE}/`, { method: 'POST' });
    expect(post.headers.get('x-nodepress-cache')).toBeNull();

    for (const headers of [
      { cookie: 'np_session=abc' },
      { cookie: 'theme=dark; __Host-np_session=abc' },
      { authorization: 'Bearer token' },
    ]) {
      expect((await get('/', headers)).headers.get('x-nodepress-cache')).toBeNull();
    }
    // An unrelated cookie does not stop caching.
    expect((await get('/', { cookie: 'theme=dark' })).headers.get('x-nodepress-cache')).toBe('hit');
  });

  it('never caches API or admin paths', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('x-nodepress-cache')).toBeNull();
    expect((await get('/api/health')).headers.get('x-nodepress-cache')).toBeNull();
  });

  it('does not store a page that was rendered while a purge happened', async () => {
    // A slow render during which the content changes: the stale page must not be kept.
    np.hooks.addFilter('render:html', async (html) => {
      await cache.purge();
      return html;
    });
    expect((await get('/')).headers.get('x-nodepress-cache')).toBe('miss');
    expect((await get('/')).headers.get('x-nodepress-cache')).toBe('miss');
  });
});
