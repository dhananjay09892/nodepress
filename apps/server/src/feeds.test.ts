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
import { createApp, type AppOptions } from './app.js';
import { FEED_ITEMS, cleanSiteUrl, xmlEscape } from './feeds.js';

const BASE = 'http://localhost';

let database: DatabaseHandle;
let content: ContentService;
let build: (feeds?: Partial<NonNullable<AppOptions['feeds']>>) => Hono;

beforeEach(async () => {
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  const np = createNodePress({ logger: silentLogger, config: { siteName: 'Feeds & <Co>' } });
  const store = createContentStore(database);
  content = createContentService({ store, hooks: np.hooks });
  const permalinks = createPermalinkService({
    store,
    redirects: createSlugRedirectsStore(database),
    options: createOptionsService({ store: createOptionsStore(database), hooks: np.hooks }),
    hooks: np.hooks,
  });
  permalinks.attach();
  build = (feeds = {}) =>
    createApp(np, database, {
      permalinks,
      feeds: {
        content,
        siteName: () => 'Feeds & <Co>',
        tagline: () => 'Just "words"',
        ...feeds,
      },
    });
});

afterEach(async () => {
  await database.close();
});

describe('xmlEscape and cleanSiteUrl', () => {
  it('escapes markup and drops control characters', () => {
    expect(xmlEscape(`<a href="x">Tom & 'Jerry'</a>\u0001`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;',
    );
  });

  it('keeps only the origin of an http(s) address', () => {
    expect(cleanSiteUrl('https://example.com/blog/')).toBe('https://example.com');
    expect(cleanSiteUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(cleanSiteUrl('javascript:alert(1)')).toBeUndefined();
    expect(cleanSiteUrl('not a url')).toBeUndefined();
    expect(cleanSiteUrl(undefined)).toBeUndefined();
  });
});

describe('/sitemap.xml', () => {
  it('lists the front page and every published page and post, and nothing else', async () => {
    await content.create({ type: 'post', title: 'Public post', status: 'published' });
    await content.create({ type: 'page', title: 'About', status: 'published' });
    await content.create({ type: 'post', title: 'Secret draft', status: 'draft' });
    await content.create({ type: 'post', title: 'Private one', status: 'private' });
    const res = await build({ siteUrl: 'https://example.com' }).request(`${BASE}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://example.com/</loc>');
    expect(xml).toContain('<loc>https://example.com/about</loc>');
    expect(xml).toContain('<loc>https://example.com/blog/public-post</loc>');
    expect(xml).toMatch(/<lastmod>\d{4}-\d\d-\d\dT[\d:.]+Z<\/lastmod>/);
    expect(xml).not.toContain('secret-draft');
    expect(xml).not.toContain('private-one');
    expect(xml.match(/<url>/g)).toHaveLength(3);
  });

  it('uses the request origin without a configured address, and ignores a bad one', async () => {
    await content.create({ type: 'page', title: 'About', status: 'published' });
    for (const siteUrl of [undefined, 'javascript:alert(1)']) {
      const xml = await (await build({ siteUrl }).request(`${BASE}/sitemap.xml`)).text();
      expect(xml).toContain('<loc>http://localhost/about</loc>');
    }
  });

  it('lists more than one page of content', async () => {
    for (let i = 0; i < 105; i++) {
      await content.create({ type: 'post', title: `Post ${i}`, status: 'published' });
    }
    const xml = await (await build().request(`${BASE}/sitemap.xml`)).text();
    expect(xml.match(/<url>/g)).toHaveLength(106);
  });
});

describe('/feed.xml', () => {
  it('is RSS 2.0 with the site, the newest posts first and escaped text', async () => {
    await content.create({
      type: 'post',
      title: 'Older & wiser',
      excerpt: 'About <things>',
      status: 'published',
      publishedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await content.create({
      type: 'post',
      title: 'Newer',
      status: 'published',
      publishedAt: new Date('2026-02-01T00:00:00Z'),
    });
    await content.create({ type: 'post', title: 'Hidden', status: 'draft' });
    await content.create({ type: 'page', title: 'A page', status: 'published' });
    const res = await build({ siteUrl: 'https://example.com' }).request(`${BASE}/feed.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/rss+xml');
    const xml = await res.text();
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('<title>Feeds &amp; &lt;Co&gt;</title>');
    expect(xml).toContain('<description>Just &quot;words&quot;</description>');
    expect(xml).toContain('<atom:link href="https://example.com/feed.xml" rel="self"');
    expect(xml.indexOf('Newer')).toBeGreaterThan(-1);
    expect(xml.indexOf('Newer')).toBeLessThan(xml.indexOf('Older'));
    expect(xml).toContain('<title>Older &amp; wiser</title>');
    expect(xml).toContain('<description>About &lt;things&gt;</description>');
    expect(xml).toContain('<link>https://example.com/blog/newer</link>');
    expect(xml).toContain('<pubDate>Sun, 01 Feb 2026 00:00:00 GMT</pubDate>');
    expect(xml).not.toContain('Hidden');
    expect(xml).not.toContain('A page');
  });

  it(`lists at most ${FEED_ITEMS} posts`, async () => {
    for (let i = 0; i < FEED_ITEMS + 5; i++) {
      await content.create({ type: 'post', title: `Post ${i}`, status: 'published' });
    }
    const xml = await (await build().request(`${BASE}/feed.xml`)).text();
    expect(xml.match(/<item>/g)).toHaveLength(FEED_ITEMS);
  });

  it('is empty but valid with no posts', async () => {
    const xml = await (await build().request(`${BASE}/feed.xml`)).text();
    expect(xml).toContain('<channel>');
    expect(xml).not.toContain('<item>');
  });
});
