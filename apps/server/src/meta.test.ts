import { HookRegistry, type Content, type MetaTags } from '@nodepress/core';
import { describe, expect, it } from 'vitest';
import {
  absoluteUrl,
  buildMeta,
  filterMeta,
  isMetaTags,
  MAX_DESCRIPTION_LENGTH,
  toDescription,
} from './meta.js';

const item = (extra: Partial<Content> = {}): Content =>
  ({ id: 1, type: 'post', title: 'Hello <b>', excerpt: null, ...extra }) as Content;
const input = {
  base: 'https://example.com',
  path: '/blog/hello',
  status: 200 as const,
  siteName: 'My Site',
  tagline: 'Just words',
  hasFeed: true,
};

describe('toDescription', () => {
  it('collapses whitespace and cuts long text near a word', () => {
    expect(toDescription('  a \n\n b\tc ')).toBe('a b c');
    const long = `${'word '.repeat(100)}end`;
    const out = toDescription(long);
    expect(out.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('absoluteUrl', () => {
  it('makes paths absolute and keeps only http(s) URLs', () => {
    expect(absoluteUrl('https://e.com', '/uploads/a.png')).toBe('https://e.com/uploads/a.png');
    expect(absoluteUrl('https://e.com', 'https://cdn.example.org/a.png')).toBe(
      'https://cdn.example.org/a.png',
    );
    expect(absoluteUrl('https://e.com', '//evil.example/a.png')).toBeUndefined();
    expect(absoluteUrl('https://e.com', 'javascript:alert(1)')).toBeUndefined();
    expect(absoluteUrl('https://e.com', undefined)).toBeUndefined();
  });
});

describe('buildMeta', () => {
  it('a post: excerpt, canonical URL, article type and image', () => {
    const meta = buildMeta({
      ...input,
      content: item({ excerpt: 'A short   summary' }),
      image: '/uploads/a.png',
    });
    expect(meta).toEqual({
      description: 'A short summary',
      canonical: 'https://example.com/blog/hello',
      feedUrl: 'https://example.com/feed.xml',
      og: {
        title: 'Hello <b>',
        description: 'A short summary',
        type: 'article',
        url: 'https://example.com/blog/hello',
        siteName: 'My Site',
        image: 'https://example.com/uploads/a.png',
      },
    });
  });

  it('a page without an excerpt uses the tagline and is a website', () => {
    const meta = buildMeta({ ...input, content: item({ type: 'page' }) });
    expect(meta.description).toBe('Just words');
    expect(meta.og.type).toBe('website');
    expect(meta.og.image).toBeUndefined();
  });

  it('the front page: site name as title, canonical is the root, falls back to the site name', () => {
    const meta = buildMeta({ ...input, path: '/', tagline: '' });
    expect(meta.canonical).toBe('https://example.com/');
    expect(meta.og.title).toBe('My Site');
    expect(meta.description).toBe('My Site');
    expect(meta.og.type).toBe('website');
  });

  it('the 404 page has no canonical or og:url, and no feed link without a feed', () => {
    const meta = buildMeta({ ...input, status: 404, hasFeed: false });
    expect(meta.canonical).toBeUndefined();
    expect(meta.og.url).toBeUndefined();
    expect(meta.feedUrl).toBeUndefined();
    expect(meta.og.title).toBe('Page not found');
  });
});

describe('filterMeta', () => {
  const base: MetaTags = buildMeta({ ...input, content: item() });
  const hooks = () => new HookRegistry();

  it('lets a plugin change the tags and tells it about the page', async () => {
    const registry = hooks();
    let seen: unknown;
    registry.addFilter('meta:tags', (meta, context) => {
      seen = context;
      return { ...meta, description: 'From a plugin' };
    });
    const out = await filterMeta(registry, base, { path: '/blog/hello', status: 200 });
    expect(out.description).toBe('From a plugin');
    expect(seen).toEqual({ path: '/blog/hello', status: 200 });
  });

  it('ignores a result that is not valid meta tags', async () => {
    const registry = hooks();
    registry.addFilter('meta:tags', () => ({ nope: true }) as unknown as MetaTags);
    expect(await filterMeta(registry, base, { path: '/', status: 200 })).toBe(base);
    expect(isMetaTags(null)).toBe(false);
    expect(isMetaTags({ ...base, robots: 5 })).toBe(false);
    expect(isMetaTags({ ...base, jsonLd: ['x'] })).toBe(false);
    expect(isMetaTags({ ...base, title: 'T', robots: 'noindex', jsonLd: [{ a: 1 }] })).toBe(true);
    expect(isMetaTags({ ...base, og: { ...base.og, type: 'video' } })).toBe(false);
  });

  it('keeps the tags when a plugin throws', async () => {
    const registry = hooks();
    registry.addFilter('meta:tags', () => {
      throw new Error('boom');
    });
    expect(await filterMeta(registry, base, { path: '/', status: 200 })).toEqual(base);
  });
});
