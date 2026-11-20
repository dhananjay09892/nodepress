import {
  createNodePress,
  createOptionsService,
  silentLogger,
  type Content,
  type MetaTags,
  type OptionRow,
  type OptionsStore,
} from '@nodepress/core';
import { describe, expect, it } from 'vitest';
import seoPlugin, {
  applySeo,
  absoluteImage,
  DEFAULT_SETTINGS,
  readSettings,
  type SeoSettings,
} from './index.js';

function memoryStore(): OptionsStore {
  const rows = new Map<string, OptionRow>();
  return {
    getAutoloaded: async () => [...rows.values()].filter((r) => r.autoload),
    get: async (key) => rows.get(key),
    upsert: async (row) => void rows.set(row.key, { ...row }),
    delete: async (key) => rows.delete(key),
  };
}

const post = {
  id: 1,
  type: 'post',
  title: 'Hello',
  excerpt: null,
  publishedAt: new Date('2026-03-04T10:00:00Z'),
  createdAt: new Date('2026-03-01T10:00:00Z'),
  updatedAt: new Date('2026-03-05T10:00:00Z'),
} as Content;

const meta = (extra: Partial<MetaTags> = {}): MetaTags => ({
  description: 'Tagline',
  canonical: 'https://example.com/blog/hello',
  og: {
    title: 'Hello',
    description: 'Tagline',
    type: 'article',
    url: 'https://example.com/blog/hello',
    siteName: 'My Site',
  },
  ...extra,
});

const settings = (extra: Partial<SeoSettings> = {}): SeoSettings => ({
  ...DEFAULT_SETTINGS,
  ...extra,
});

describe('absoluteImage', () => {
  it('resolves paths against the page and accepts only http(s)', () => {
    expect(absoluteImage('/uploads/a.png', 'https://example.com/blog/hello')).toBe(
      'https://example.com/uploads/a.png',
    );
    expect(absoluteImage('https://cdn.example.org/a.png', undefined)).toBe(
      'https://cdn.example.org/a.png',
    );
    expect(absoluteImage('javascript:alert(1)', 'https://example.com/')).toBeUndefined();
    expect(absoluteImage('//evil.example/a.png', 'https://example.com/')).toBeUndefined();
    expect(absoluteImage('/a.png', undefined)).toBeUndefined();
    expect(absoluteImage('', 'https://example.com/')).toBeUndefined();
  });
});

describe('readSettings', () => {
  it('uses defaults for missing or odd values', () => {
    expect(readSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(
      readSettings({ noindex_site: true, organization_name: ' Acme ', schema_enabled: false }),
    ).toMatchObject({ noindexSite: true, organizationName: 'Acme', schemaEnabled: false });
    expect(readSettings({ default_social_image: 5 }).defaultSocialImage).toBe('');
  });
});

describe('applySeo', () => {
  it('uses the per-post title, description and image', () => {
    const out = applySeo(
      meta(),
      {
        status: 200,
        content: post,
        fields: {
          seo_title: '  Better   title ',
          seo_description: 'A better description',
          seo_image: '/uploads/share.png',
        },
      },
      settings(),
    );
    expect(out.title).toBe('Better title | My Site');
    expect(out.description).toBe('A better description');
    expect(out.og).toMatchObject({
      title: 'Better title',
      description: 'A better description',
      image: 'https://example.com/uploads/share.png',
    });
  });

  it('keeps the original tags when nothing is customised', () => {
    const out = applySeo(meta(), { status: 200, content: post }, settings({ schemaEnabled: false }));
    expect(out).toEqual(meta());
  });

  it('falls back to the default social image, and an unsafe per-post image is ignored', () => {
    const out = applySeo(
      meta(),
      { status: 200, content: post, fields: { seo_image: 'javascript:alert(1)' } },
      settings({ defaultSocialImage: 'https://cdn.example.org/default.png' }),
    );
    expect(out.og.image).toBe('https://cdn.example.org/default.png');
  });

  it('robots: site-wide noindex, per-item noindex and the 404 page', () => {
    const base = { status: 200 as const, content: post };
    expect(applySeo(meta(), base, settings({ noindexSite: true })).robots).toBe(
      'noindex, nofollow',
    );
    expect(
      applySeo(meta(), { ...base, fields: { seo_noindex: true } }, settings()).robots,
    ).toBe('noindex, follow');
    expect(applySeo(meta(), { status: 404 }, settings()).robots).toBe('noindex');
    expect(applySeo(meta(), base, settings()).robots).toBeUndefined();
    expect(
      applySeo(meta({ robots: 'noarchive' }), base, settings()).robots,
    ).toBe('noarchive');
  });

  it('JSON-LD: Article for posts with the publisher, WebPage for pages', () => {
    const article = applySeo(
      meta(),
      { status: 200, content: post },
      settings({ organizationName: 'Acme' }),
    ).jsonLd;
    expect(article).toEqual([
      {
        '@context': 'https://schema.org',
        '@type': 'Article',
        description: 'Tagline',
        url: 'https://example.com/blog/hello',
        mainEntityOfPage: 'https://example.com/blog/hello',
        headline: 'Hello',
        datePublished: '2026-03-04T10:00:00.000Z',
        dateModified: '2026-03-05T10:00:00.000Z',
        publisher: { '@type': 'Organization', name: 'Acme' },
      },
    ]);
    const page = applySeo(
      meta(),
      { status: 200, content: { ...post, type: 'page', title: 'About' } as Content },
      settings(),
    ).jsonLd;
    expect(page?.[0]).toMatchObject({ '@type': 'WebPage', name: 'Hello' });
    expect(page?.[0]).not.toHaveProperty('mainEntityOfPage');
  });

  it('JSON-LD: WebSite (and Organization) on the front page, none on the 404 page or when off', () => {
    const front = applySeo(meta(), { status: 200 }, settings({ organizationName: 'Acme' }));
    expect(front.jsonLd?.map((d) => d['@type'])).toEqual(['WebSite', 'Organization']);
    expect(applySeo(meta(), { status: 404 }, settings()).jsonLd).toBeUndefined();
    expect(
      applySeo(meta(), { status: 200, content: post }, settings({ schemaEnabled: false })).jsonLd,
    ).toBeUndefined();
  });

  it('keeps JSON-LD that another plugin already added', () => {
    const out = applySeo(
      meta({ jsonLd: [{ '@type': 'Thing' }] }),
      { status: 200, content: post },
      settings(),
    );
    expect(out.jsonLd?.map((d) => d['@type'])).toEqual(['Thing', 'Article']);
  });
});

describe('the SEO plugin in a running site', () => {
  async function boot() {
    const np = createNodePress({ logger: silentLogger, plugins: [seoPlugin] });
    await np.boot();
    np.admin.useOptions(createOptionsService({ store: memoryStore(), hooks: np.hooks }));
    return np;
  }
  const filter = (np: Awaited<ReturnType<typeof boot>>, extra = {}) =>
    np.hooks.applyFilters('meta:tags', meta(), { path: '/blog/hello', status: 200, ...extra });

  it('adds an SEO menu item and settings page for administrators', async () => {
    const np = await boot();
    const view = await np.admin.describe(async (c) => c === 'manage_options');
    expect(view.menu).toEqual([{ plugin: 'seo', id: 'seo', label: 'SEO', page: 'settings' }]);
    expect(view.pages.map((p) => p.title)).toEqual(['SEO settings']);
  });

  it('registers the per-post fields on posts and pages', async () => {
    const np = await boot();
    const types = await np.hooks.applyFilters('content-type:fields', [], { type: 'post' });
    const names = (types as Array<{ name: string }>).map((f) => f.name);
    expect(names).toEqual(['seo_title', 'seo_description', 'seo_image', 'seo_noindex']);
  });

  it('applies the saved settings to the meta:tags filter', async () => {
    const np = await boot();
    await np.admin.writePanel('seo', 'settings', 'general', {
      noindex_site: true,
      organization_name: 'Acme',
    });
    const out = await filter(np, { content: post });
    expect(out.robots).toBe('noindex, nofollow');
    expect(out.jsonLd?.[0]).toMatchObject({ publisher: { name: 'Acme' } });
  });

  it('works with defaults when settings were never saved, and stops when deactivated', async () => {
    const np = await boot();
    const out = await filter(np, { fields: { seo_title: 'T' }, content: post });
    expect(out.title).toBe('T | My Site');
    await np.plugins.deactivate('seo');
    expect(await filter(np, { fields: { seo_title: 'T' }, content: post })).toEqual(meta());
  });
});
