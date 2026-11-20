import { describe, expect, it } from 'vitest';
import type { ContentRecord } from './content.js';
import {
  importWordPress,
  mediaKey,
  normalizePath,
  parseWpDate,
  type WordPressImportOptions,
} from './wordpress-import.js';
import { WXR_FIXTURE } from './testing/wxr-fixture.js';

const NOW = new Date('2026-11-20T12:00:00Z');

function harness(overrides: Partial<WordPressImportOptions> = {}) {
  const records = new Map<number, ContentRecord>();
  const terms = new Map<
    string,
    { id: number; name: string; parentId: number | null; description: string | null }
  >();
  const assigned = new Map<string, number[]>();
  const metas = new Map<number, Record<string, unknown>>();
  let nextId = 100;
  let nextTerm = 1;
  const options: WordPressImportOptions = {
    content: {
      async create(input) {
        const same = [...records.values()].filter(
          (r) => r.type === input.type && r.slug.startsWith(input.slug ?? 'x'),
        );
        const slug =
          input.slug ??
          (input.title ?? 'untitled')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
        const record: ContentRecord = {
          id: nextId++,
          type: input.type,
          status: input.status ?? 'draft',
          title: input.title ?? '',
          slug: same.length > 0 ? `${slug}-${same.length + 1}` : slug,
          body: input.body ?? [],
          excerpt: input.excerpt ?? null,
          authorId: input.authorId ?? null,
          parentId: input.parentId ?? null,
          publishedAt: input.publishedAt ?? null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        records.set(record.id, record);
        return record;
      },
      async update(id, input) {
        const record = records.get(id)!;
        Object.assign(record, input);
        return record;
      },
    },
    taxonomies: {
      async getTermBySlug(taxonomy, slug) {
        const t = terms.get(`${taxonomy}:${slug}`);
        return t ? ({ id: t.id, taxonomy, slug, name: t.name } as never) : undefined;
      },
      async createTerm(input) {
        const t = {
          id: nextTerm++,
          name: input.name,
          parentId: input.parentId ?? null,
          description: input.description ?? null,
        };
        terms.set(`${input.taxonomy}:${input.slug}`, t);
        return { id: t.id, taxonomy: input.taxonomy, slug: input.slug, name: input.name } as never;
      },
      async setContentTerms(contentId, taxonomy, ids) {
        assigned.set(`${contentId}:${taxonomy}`, ids);
        return [] as never;
      },
    },
    permalinks: {
      async pathFor(content) {
        return content.type === 'post'
          ? `/blog/${content.slug}`
          : content.parentId
            ? `/${records.get(content.parentId)!.slug}/${content.slug}`
            : `/${content.slug}`;
      },
    },
    meta: {
      async setMeta(id, values) {
        metas.set(id, values);
      },
    },
    now: () => NOW,
    ...overrides,
  };
  return { options, records, terms, assigned, metas };
}

const byTitle = (records: Map<number, ContentRecord>, title: string): ContentRecord =>
  [...records.values()].find((r) => r.title === title)!;

describe('importWordPress', () => {
  it('imports the fixture: content, statuses, dates, authors, parents', async () => {
    const h = harness({ resolveAuthor: (a) => (a.login === 'jane' ? 7 : null) });
    const report = await importWordPress(WXR_FIXTURE, h.options);

    expect(report.site).toEqual({ title: 'Old & Gold', url: 'https://old.example.com' });
    expect(report.created).toMatchObject({ posts: 3, pages: 2, categories: 2, tags: 2 });
    expect(report.idMap).toEqual({ '10': 100, '11': 101, '20': 102, '21': 103, '22': 104 });

    const about = byTitle(h.records, 'About us');
    expect(about).toMatchObject({
      type: 'page',
      status: 'published',
      slug: 'about',
      authorId: 7,
      parentId: null,
    });
    expect(about.publishedAt?.toISOString()).toBe('2024-01-02T08:00:00.000Z');

    const team = byTitle(h.records, 'Team');
    expect(team.parentId).toBe(about.id);
    expect(team.body).toEqual([
      { type: 'core/paragraph', content: [{ text: 'Just us.' }] },
      { type: 'core/paragraph', content: [{ text: 'Two people.' }] },
    ]);

    const draft = byTitle(h.records, 'Draft idea');
    expect(draft).toMatchObject({ status: 'draft', publishedAt: null, authorId: null });

    const future = byTitle(h.records, 'Coming soon');
    expect(future.status).toBe('scheduled');
    expect(future.publishedAt?.getUTCFullYear()).toBe(2099);

    const rome = byTitle(h.records, 'Hello Rome');
    expect(rome.excerpt).toBe('Ciao');
    expect(rome.body.map((b) => b.type)).toEqual([
      'core/paragraph',
      'core/heading',
      'core/list',
      'core/image',
    ]);
    expect(JSON.stringify(rome.body)).not.toContain('alert');
  });

  it('creates categories (parents first) and tags, assigns them, and ignores other taxonomies', async () => {
    const h = harness();
    await importWordPress(WXR_FIXTURE, h.options);
    expect(h.terms.get('category:travel')).toMatchObject({
      name: 'Travel',
      parentId: null,
      description: 'Trips',
    });
    expect(h.terms.get('category:travel-italy')?.parentId).toBe(h.terms.get('category:travel')?.id);
    expect([...h.terms.keys()].filter((k) => k.startsWith('tag:')).sort()).toEqual([
      'tag:new-tag',
      'tag:rome',
    ]);
    expect([...h.terms.keys()].some((k) => k.startsWith('series'))).toBe(false);
    const romeId = byTitle(h.records, 'Hello Rome').id;
    expect(h.assigned.get(`${romeId}:category`)).toEqual([
      h.terms.get('category:travel-italy')!.id,
    ]);
    expect(h.assigned.get(`${romeId}:tag`)).toHaveLength(2);
  });

  it('keeps ids, links and comments as meta', async () => {
    const h = harness();
    await importWordPress(WXR_FIXTURE, h.options);
    const rome = byTitle(h.records, 'Hello Rome');
    const meta = h.metas.get(rome.id)!;
    expect(meta['wp_id']).toBe(20);
    expect(meta['wp_link']).toBe('https://old.example.com/2024/05/hello-rome/');
    expect(meta['wp_comments']).toEqual([
      expect.objectContaining({ author: 'Bob', content: 'Nice!' }),
    ]);
    expect(h.metas.get(byTitle(h.records, 'About us').id)).not.toHaveProperty('wp_comments');
  });

  it('builds the redirect map for public items whose URL changed', async () => {
    const h = harness();
    const report = await importWordPress(WXR_FIXTURE, h.options);
    // /about and /about/team keep their URLs; the draft has no public URL to keep.
    expect(report.redirects).toEqual([
      { from: '/2024/05/hello-rome', to: '/blog/hello-rome' },
      { from: '/2099/01/coming-soon', to: '/blog/coming-soon' },
    ]);
  });

  it('rewrites links between imported items and leaves external ones alone', async () => {
    const h = harness();
    const report = await importWordPress(WXR_FIXTURE, h.options);
    const about = byTitle(h.records, 'About us');
    expect(JSON.stringify(about.body)).toContain('"href":"/blog/hello-rome"');
    const rome = byTitle(h.records, 'Hello Rome');
    const text = JSON.stringify(rome.body);
    expect(text).toContain('"href":"/about"');
    expect(text).toContain('"href":"/about/team"'); // ?page_id=11
    expect(text).toContain('"href":"https://elsewhere.test/x"');
    expect(report.linksRewritten).toBe(3);
  });

  it('lists attachments with their post, and reports unsupported content', async () => {
    const h = harness();
    const report = await importWordPress(WXR_FIXTURE, h.options);
    expect(report.attachments).toEqual([
      {
        id: 30,
        url: 'https://old.example.com/wp-content/uploads/rome.jpg',
        title: 'rome.jpg',
        alt: 'The Colosseum',
        contentId: report.idMap['20'],
      },
    ]);
    expect(report.skipped).toEqual([
      { id: 40, title: 'Product', type: 'product', reason: '"product" content is not imported' },
    ]);
  });

  it('isolates a failing item and keeps going', async () => {
    const h = harness();
    const create = h.options.content.create;
    h.options.content.create = async (input) => {
      if (input.title === 'Team') throw new Error('nope');
      return create(input);
    };
    const report = await importWordPress(WXR_FIXTURE, h.options);
    expect(report.created.pages).toBe(1);
    expect(report.skipped.map((s) => [s.title, s.reason])).toContainEqual(['Team', 'nope']);
    expect(report.created.posts).toBe(3);
  });

  it('uses the default author, replaces odd slugs, and puts a past "future" item live', async () => {
    const xml = `<rss><channel><title>S</title><link>https://a.test</link>
      <item><title>Zażółć</title><link>https://a.test/za%C5%BC/</link><dc:creator>x</dc:creator>
      <wp:post_id>1</wp:post_id><wp:post_name>za%C5%BC</wp:post_name><wp:status>future</wp:status>
      <wp:post_date_gmt>2020-01-01 00:00:00</wp:post_date_gmt><wp:post_type>post</wp:post_type>
      <content:encoded><![CDATA[x]]></content:encoded></item></channel></rss>`;
    const h = harness({ defaultAuthorId: 3 });
    const report = await importWordPress(xml, h.options);
    const record = byTitle(h.records, 'Zażółć');
    expect(record).toMatchObject({ status: 'published', authorId: 3 });
    expect(record.publishedAt?.getUTCFullYear()).toBe(2020);
    expect(report.warnings[0]).toMatch(/slug "za%C5%BC" was replaced/);
  });

  it('rejects text that is not a WordPress export', async () => {
    await expect(importWordPress('<html/>', harness().options)).rejects.toThrow(
      /not a WordPress export/,
    );
  });
});

describe('media download', () => {
  const ROME = 'https://old.example.com/wp-content/uploads/rome.jpg';

  it('downloads attachments, rewrites image addresses and sets the featured image', async () => {
    const seen: string[] = [];
    const h = harness({
      importMedia: async (file) => {
        seen.push(file.url);
        return { id: 55, url: '/uploads/2024/rome.jpg' };
      },
    });
    const report = await importWordPress(WXR_FIXTURE, h.options);
    expect(seen).toEqual([ROME]);
    expect(report.media?.imported).toEqual([
      { url: ROME, mediaId: 55, newUrl: '/uploads/2024/rome.jpg', wpId: 30 },
    ]);
    expect(report.media?.failed).toEqual([]);
    expect(report.media?.featuredImages).toBe(1);
    expect(report.media?.imagesRewritten).toBeGreaterThan(0);
    const rome = byTitle(h.records, 'Hello Rome');
    expect(JSON.stringify(rome.body)).toContain('/uploads/2024/rome.jpg');
    expect(JSON.stringify(rome.body)).not.toContain(ROME);
    expect(h.metas.get(rome.id)).toMatchObject({ featured_image: 55 });
  });

  it('reports files that fail and keeps going', async () => {
    const h = harness({
      importMedia: async () => {
        throw new Error('blocked_host');
      },
    });
    const report = await importWordPress(WXR_FIXTURE, h.options);
    expect(report.media?.imported).toEqual([]);
    expect(report.media?.failed).toEqual([{ url: ROME, reason: 'blocked_host' }]);
    expect(JSON.stringify(byTitle(h.records, 'Hello Rome').body)).toContain(ROME);
  });

  it('stops at maxMediaFiles', async () => {
    let calls = 0;
    const h = harness({
      maxMediaFiles: 0,
      importMedia: async () => {
        calls++;
        return { id: 1, url: '/x' };
      },
    });
    const report = await importWordPress(WXR_FIXTURE, h.options);
    expect(calls).toBe(0);
    expect(report.media?.failed).toHaveLength(1);
  });

  it('does nothing without importMedia', async () => {
    const report = await importWordPress(WXR_FIXTURE, harness().options);
    expect(report.media).toBeUndefined();
  });

  it('mediaKey ignores scheme, size suffixes and -scaled', () => {
    expect(mediaKey('http://a.com/up/x-300x200.jpg')).toBe(mediaKey('https://a.com/up/x.jpg'));
    expect(mediaKey('https://a.com/up/x-scaled.jpg')).toBe(mediaKey('https://a.com/up/x.jpg'));
  });
});

describe('helpers', () => {
  it('parseWpDate reads WordPress dates as UTC and ignores the zero date', () => {
    expect(parseWpDate('2024-05-01 10:00:00')?.toISOString()).toBe('2024-05-01T10:00:00.000Z');
    expect(parseWpDate('0000-00-00 00:00:00')).toBeUndefined();
    expect(parseWpDate('')).toBeUndefined();
    expect(parseWpDate('2024-13-45 99:00:00')).toBeUndefined();
  });

  it('normalizePath drops query, hash and trailing slashes', () => {
    expect(normalizePath('/a/b/?x=1#y')).toBe('/a/b');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('a')).toBe('/a');
  });
});
