import {
  createNodePress,
  createOptionsService,
  silentLogger,
  type Content,
  type MetaTags,
  type OptionRow,
  type OptionsStore,
} from '@nodepress/core';
import seoPlugin from '@nodepress/plugin-seo';
import { describe, expect, it } from 'vitest';

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

const meta = (): MetaTags => ({
  description: 'Tagline',
  canonical: 'https://example.com/blog/hello',
  og: {
    title: 'Hello',
    description: 'Tagline',
    type: 'article',
    url: 'https://example.com/blog/hello',
    siteName: 'My Site',
  },
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
