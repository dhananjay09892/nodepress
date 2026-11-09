import { describe, expect, it } from 'vitest';
import {
  createContentService,
  type ContentRecord,
  type ContentService,
  type ContentStore,
  type RevisionRecord,
} from './content.js';
import { HookRegistry } from './hooks.js';
import { createOptionsService, type OptionRow, type OptionsStore } from './options.js';
import {
  buildPath,
  createPermalinkService,
  parsePattern,
  PermalinkPatternError,
  PERMALINK_OPTION,
  type SlugRedirectStore,
} from './permalinks.js';

const NOW = new Date('2026-11-09T12:00:00.000Z');

function contentStore(): ContentStore {
  const rows = new Map<number, ContentRecord>();
  const revisions: RevisionRecord[] = [];
  let nextId = 1;
  return {
    async insert(row) {
      const rec: ContentRecord = { ...row, id: nextId++, createdAt: NOW, updatedAt: NOW };
      rows.set(rec.id, rec);
      return rec;
    },
    async findById(id) {
      return rows.get(id);
    },
    async findBySlug(type, slug) {
      return [...rows.values()].find((r) => r.type === type && r.slug === slug);
    },
    async slugExists(type, slug, excludeId) {
      return [...rows.values()].some(
        (r) => r.type === type && r.slug === slug && r.id !== excludeId,
      );
    },
    async update(id, patch) {
      const rec = rows.get(id);
      if (!rec) return undefined;
      const next = { ...rec, ...patch };
      rows.set(id, next);
      return next;
    },
    async delete(id) {
      return rows.delete(id);
    },
    async list() {
      return [...rows.values()];
    },
    async insertRevision(row) {
      const rev: RevisionRecord = { id: revisions.length + 1, ...row, createdAt: NOW };
      revisions.push(rev);
      return rev;
    },
    async listRevisions(contentId) {
      return revisions.filter((r) => r.contentId === contentId);
    },
    async findRevision(id) {
      return revisions.find((r) => r.id === id);
    },
  };
}

function optionsStore(): OptionsStore {
  const rows = new Map<string, OptionRow>();
  return {
    async getAutoloaded() {
      return [...rows.values()];
    },
    async get(key) {
      return rows.get(key);
    },
    async upsert(row) {
      rows.set(row.key, row);
    },
    async delete(key) {
      return rows.delete(key);
    },
  };
}

function redirectStore(): SlugRedirectStore & { failNext: boolean } {
  const rows = new Map<string, number>();
  const store = {
    failNext: false,
    async upsert(row: { contentId: number; type: string; slug: string }) {
      if (store.failNext) {
        store.failNext = false;
        throw new Error('db down');
      }
      rows.set(`${row.type}:${row.slug}`, row.contentId);
    },
    async find(type: string, slug: string) {
      const contentId = rows.get(`${type}:${slug}`);
      return contentId === undefined ? undefined : { contentId };
    },
    async delete(type: string, slug: string) {
      return rows.delete(`${type}:${slug}`);
    },
  };
  return store;
}

function setup(contentTypes?: () => string[]) {
  const hooks = new HookRegistry();
  const store = contentStore();
  const redirects = redirectStore();
  const options = createOptionsService({ store: optionsStore(), hooks });
  const content: ContentService = createContentService({ store, hooks, now: () => NOW });
  const permalinks = createPermalinkService({
    store,
    redirects,
    options,
    hooks,
    now: () => NOW,
    ...(contentTypes ? { contentTypes } : {}),
  });
  permalinks.attach();
  return { hooks, store, redirects, options, content, permalinks };
}

describe('parsePattern', () => {
  it.each([
    '/:slug',
    '/blog/:slug',
    '/:year/:month/:slug',
    '/:year/:month/:day/:slug',
    '/p/:id',
    '/news-2026/:slug',
  ])('accepts %s', (pattern) => {
    expect(parsePattern(pattern).pattern).toBe(pattern);
  });

  it.each([
    '',
    'blog/:slug',
    '/blog/:slug/',
    '/blog//:slug',
    '/blog',
    '/:id/:slug',
    '/:slug/:slug',
    '/:author/:slug',
    '/Blog/:slug',
    '/blog space/:slug',
    '/../:slug',
  ])('rejects %j', (pattern) => {
    expect(() => parsePattern(pattern)).toThrow(PermalinkPatternError);
  });

  it('rejects a pattern that is too long', () => {
    expect(() => parsePattern('/' + 'a'.repeat(300) + '/:slug')).toThrow(PermalinkPatternError);
  });
});

describe('buildPath', () => {
  it('fills tokens, using UTC publish date parts', () => {
    const { content } = setup();
    const item = {
      id: 7,
      slug: 'hello',
      publishedAt: new Date('2026-01-05T23:30:00.000Z'),
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    } as unknown as Parameters<typeof buildPath>[1];
    expect(content).toBeDefined();
    expect(buildPath(parsePattern('/:year/:month/:day/:slug'), item)).toBe('/2026/01/05/hello');
    expect(buildPath(parsePattern('/p/:id'), item)).toBe('/p/7');
  });
});

describe('structure option', () => {
  it('defaults to /blog/:slug, saves valid patterns, rejects invalid ones', async () => {
    const { permalinks, options } = setup();
    expect(await permalinks.getStructure()).toBe('/blog/:slug');
    await permalinks.setStructure('/:year/:month/:slug');
    expect(await permalinks.getStructure()).toBe('/:year/:month/:slug');
    await expect(permalinks.setStructure('nope')).rejects.toBeInstanceOf(PermalinkPatternError);
    expect(await permalinks.getStructure()).toBe('/:year/:month/:slug');
    // A bad stored value falls back to the default instead of breaking the site.
    await options.set(PERMALINK_OPTION, '/broken//');
    expect(await permalinks.getStructure()).toBe('/blog/:slug');
  });
});

describe('resolve', () => {
  it('resolves published posts and pages', async () => {
    const { content, permalinks } = setup();
    const post = await content.create({ type: 'post', title: 'Hello World', status: 'published' });
    const page = await content.create({ type: 'page', title: 'About', status: 'published' });
    expect(await permalinks.resolve('/blog/hello-world')).toMatchObject({
      kind: 'content',
      status: 200,
      content: { id: post.id },
      path: '/blog/hello-world',
    });
    expect(await permalinks.resolve('/about')).toMatchObject({
      kind: 'content',
      content: { id: page.id },
    });
    expect(await permalinks.pathFor(post)).toBe('/blog/hello-world');
    expect(await permalinks.pathFor(page)).toBe('/about');
  });

  it('answers 404 for unknown, unpublished, future and malformed paths', async () => {
    const { content, permalinks } = setup();
    await content.create({ type: 'post', title: 'Draft', status: 'draft' });
    await content.create({ type: 'post', title: 'Private', status: 'private' });
    const trashed = await content.create({ type: 'post', title: 'Gone', status: 'published' });
    await content.trash(trashed.id);
    await content.create({
      type: 'post',
      title: 'Soon',
      status: 'scheduled',
      publishedAt: new Date(NOW.getTime() + 3600_000),
    });
    for (const path of [
      '/',
      '/blog/missing',
      '/blog/draft',
      '/blog/private',
      '/blog/gone',
      '/blog/soon',
      '/blog/%E0%A4%A',
      '/blog/../about',
      '/blog//draft',
      '/blog/Hello',
      'blog/x',
      '/nothing/here/at/all',
    ]) {
      expect(await permalinks.resolve(path), path).toEqual({ kind: 'not_found', status: 404 });
    }
  });

  it('does not cross content types', async () => {
    const { content, permalinks } = setup();
    await content.create({ type: 'page', title: 'About', status: 'published' });
    expect((await permalinks.resolve('/blog/about')).kind).toBe('not_found');
  });

  it('redirects a trailing slash to the canonical URL', async () => {
    const { content, permalinks } = setup();
    await content.create({ type: 'post', title: 'Hello', status: 'published' });
    expect(await permalinks.resolve('/blog/hello/')).toEqual({
      kind: 'redirect',
      status: 301,
      to: '/blog/hello',
    });
  });

  it('supports date patterns and redirects wrong dates to the real one', async () => {
    const { content, permalinks } = setup();
    await permalinks.setStructure('/:year/:month/:slug');
    await content.create({
      type: 'post',
      title: 'Dated',
      status: 'published',
      publishedAt: new Date('2026-03-04T10:00:00.000Z'),
    });
    expect((await permalinks.resolve('/2026/03/dated')).kind).toBe('content');
    expect(await permalinks.resolve('/2025/12/dated')).toEqual({
      kind: 'redirect',
      status: 301,
      to: '/2026/03/dated',
    });
    expect((await permalinks.resolve('/2026/03/other')).kind).toBe('not_found');
  });

  it('supports id patterns', async () => {
    const { content, permalinks } = setup();
    await permalinks.setStructure('/p/:id');
    const post = await content.create({ type: 'post', title: 'By id', status: 'published' });
    expect(await permalinks.resolve(`/p/${post.id}`)).toMatchObject({ kind: 'content' });
    expect((await permalinks.resolve('/p/999')).kind).toBe('not_found');
    expect((await permalinks.resolve('/p/0')).kind).toBe('not_found');
  });

  it('gives custom types /:type/:slug and honours the permalink:pattern filter', async () => {
    const { content, permalinks, hooks } = setup(() => ['page', 'post', 'product']);
    // The content service only knows post/page unless a type registry says otherwise;
    // seed the custom type straight through the service's store contract.
    const product = await content.create({ type: 'product', title: 'Mug', status: 'published' });
    expect(await permalinks.pathFor(product)).toBe('/product/mug');
    expect((await permalinks.resolve('/product/mug')).kind).toBe('content');

    hooks.addFilter('permalink:pattern', (value, { type }) =>
      type === 'product' ? '/shop/:slug' : value,
    );
    expect((await permalinks.resolve('/shop/mug')).kind).toBe('content');
    expect((await permalinks.resolve('/product/mug')).kind).toBe('not_found');

    // An invalid override is ignored.
    hooks.addFilter('permalink:pattern', (value, { type }) => (type === 'product' ? 'bad' : value), {
      priority: 20,
    });
    expect((await permalinks.resolve('/product/mug')).kind).toBe('content');
  });
});

describe('slug-change redirects', () => {
  it('redirects the old URL to the new one, across several renames', async () => {
    const { content, permalinks } = setup();
    const post = await content.create({ type: 'post', title: 'First', status: 'published' });
    await content.update(post.id, { slug: 'second' });
    await content.update(post.id, { slug: 'third' });
    for (const old of ['first', 'second']) {
      expect(await permalinks.resolve(`/blog/${old}`)).toEqual({
        kind: 'redirect',
        status: 301,
        to: '/blog/third',
      });
    }
    expect((await permalinks.resolve('/blog/third')).kind).toBe('content');
  });

  it('does not record anything when the slug is unchanged', async () => {
    const { content, redirects } = setup();
    const post = await content.create({ type: 'post', title: 'Same', status: 'published' });
    await content.update(post.id, { title: 'Same, edited' });
    expect(await redirects.find('post', 'same')).toBeUndefined();
  });

  it('lets new content take over an old slug, and renaming back clears the redirect', async () => {
    const { content, permalinks, redirects } = setup();
    const a = await content.create({ type: 'post', title: 'Alpha', status: 'published' });
    await content.update(a.id, { slug: 'beta' });
    const b = await content.create({ type: 'post', title: 'Alpha', slug: 'alpha', status: 'published' });
    expect(await permalinks.resolve('/blog/alpha')).toMatchObject({
      kind: 'content',
      content: { id: b.id },
    });
    await content.update(b.id, { slug: 'gamma' });
    // 'alpha' now points at b (its newest owner)
    expect(await permalinks.resolve('/blog/alpha')).toMatchObject({ to: '/blog/gamma' });
    await content.update(b.id, { slug: 'alpha' });
    expect(await redirects.find('post', 'alpha')).toBeUndefined();
  });

  it('does not redirect to unpublished content', async () => {
    const { content, permalinks } = setup();
    const post = await content.create({ type: 'post', title: 'Old', status: 'published' });
    await content.update(post.id, { slug: 'new', status: 'draft' });
    expect((await permalinks.resolve('/blog/old')).kind).toBe('not_found');
  });

  it('never fails a save when recording the redirect fails', async () => {
    const { content, redirects } = setup();
    const post = await content.create({ type: 'post', title: 'Keep', status: 'published' });
    redirects.failNext = true;
    const updated = await content.update(post.id, { slug: 'kept' });
    expect(updated.slug).toBe('kept');
  });

  it('stops recording after the returned unsubscribe', async () => {
    const hooks = new HookRegistry();
    const store = contentStore();
    const redirects = redirectStore();
    const content = createContentService({ store, hooks, now: () => NOW });
    const permalinks = createPermalinkService({
      store,
      redirects,
      options: createOptionsService({ store: optionsStore(), hooks }),
      hooks,
    });
    const detach = permalinks.attach();
    const post = await content.create({ type: 'post', title: 'One', status: 'published' });
    detach();
    await content.update(post.id, { slug: 'two' });
    expect(await redirects.find('post', 'one')).toBeUndefined();
  });
});
