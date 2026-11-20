import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createContentService,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  createThemeService,
  discoverThemes,
  silentLogger,
  type ContentService,
  type NodePress,
  type ThemeService,
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
import { createApp, type AppOptions } from './app.js';

const BASE = 'http://shop.test';

let root: string;
let database: DatabaseHandle;
let content: ContentService;
let themes: ThemeService;
let np: NodePress;
let build: (extra?: Partial<AppOptions>) => Hono;

/** A theme whose every template prints the `meta` prop as JSON. */
async function boot(): Promise<void> {
  await writeFile(
    join(root, 'demo', 'templates', 'index.mjs'),
    `export default (p) => '<pre>' + JSON.stringify(p.meta) + '</pre>';`,
  );
  themes.register((await discoverThemes(root)).themes);
  themes.activate('demo');
}

async function metaOf(app: Hono, path: string) {
  const res = await app.request(`${BASE}${path}`);
  const html = await res.text();
  const json = /<pre>(.*)<\/pre>/s.exec(html)?.[1];
  return { status: res.status, meta: json ? JSON.parse(json) : undefined };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'np-meta-'));
  await mkdir(join(root, 'demo', 'templates'), { recursive: true });
  await writeFile(
    join(root, 'demo', 'theme.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0' }),
  );
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  np = createNodePress({ logger: silentLogger, config: { siteName: 'Shop' } });
  const store = createContentStore(database);
  content = createContentService({ store, hooks: np.hooks });
  const permalinks = createPermalinkService({
    store,
    redirects: createSlugRedirectsStore(database),
    options: createOptionsService({ store: createOptionsStore(database), hooks: np.hooks }),
    hooks: np.hooks,
  });
  permalinks.attach();
  themes = createThemeService({ hooks: np.hooks, logger: silentLogger });
  build = (extra = {}) =>
    createApp(np, database, {
      permalinks,
      themes: { service: themes, tagline: () => 'Good things' },
      ...extra,
    });
  await boot();
});

afterEach(async () => {
  await database.close();
  await rm(root, { recursive: true, force: true });
});

describe('the meta template prop', () => {
  it('front page: tagline as description, canonical from the request origin', async () => {
    const { meta } = await metaOf(build(), '/');
    expect(meta.description).toBe('Good things');
    expect(meta.canonical).toBe('http://shop.test/');
    expect(meta.og).toMatchObject({ title: 'Shop', type: 'website', siteName: 'Shop' });
    expect(meta.feedUrl).toBeUndefined();
  });

  it('post: excerpt, article type, canonical, featured image and the feed link', async () => {
    await content.create({
      type: 'post',
      title: 'One',
      slug: 'one',
      excerpt: 'About one',
      status: 'published',
    });
    const app = build({
      feeds: { content, siteName: () => 'Shop' },
      themes: {
        service: themes,
        tagline: () => 'Good things',
        featuredImage: async () => '/uploads/one.png',
      },
    });
    const { meta } = await metaOf(app, '/blog/one');
    expect(meta.description).toBe('About one');
    expect(meta.canonical).toBe('http://shop.test/blog/one');
    expect(meta.feedUrl).toBe('http://shop.test/feed.xml');
    expect(meta.og).toMatchObject({
      title: 'One',
      type: 'article',
      url: 'http://shop.test/blog/one',
      image: 'http://shop.test/uploads/one.png',
    });
  });

  it('page without an excerpt: tagline description and website type', async () => {
    await content.create({ type: 'page', title: 'About', slug: 'about', status: 'published' });
    const { meta } = await metaOf(build(), '/about');
    expect(meta.description).toBe('Good things');
    expect(meta.og.type).toBe('website');
  });

  it('404: no canonical and no og:url', async () => {
    const { status, meta } = await metaOf(build(), '/missing');
    expect(status).toBe(404);
    expect(meta.canonical).toBeUndefined();
    expect(meta.og.url).toBeUndefined();
    expect(meta.og.title).toBe('Page not found');
  });

  it('uses the configured SITE_URL instead of the request origin', async () => {
    const app = build({
      themes: { service: themes, siteUrl: 'https://www.example.com/ignored/path' },
    });
    const { meta } = await metaOf(app, '/');
    expect(meta.canonical).toBe('https://www.example.com/');
  });

  it('runs the meta:tags filter', async () => {
    np.hooks.addFilter('meta:tags', (meta, context) => ({
      ...meta,
      description: `Filtered ${context.path}`,
    }));
    const { meta } = await metaOf(build(), '/');
    expect(meta.description).toBe('Filtered /');
  });

  it('still draws the page when the featured image lookup fails', async () => {
    await content.create({ type: 'post', title: 'Two', slug: 'two', status: 'published' });
    const app = build({
      themes: {
        service: themes,
        featuredImage: () => Promise.reject(new Error('media down')),
      },
    });
    const { status, meta } = await metaOf(app, '/blog/two');
    expect(status).toBe(200);
    expect(meta.og.image).toBeUndefined();
  });
});
