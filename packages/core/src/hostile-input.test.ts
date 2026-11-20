import { describe, expect, it } from 'vitest';
import { exportSite, importSite, type BackupDeps } from './backup.js';
import type { ContentRecord } from './content.js';
import { htmlToBlocks } from './html-blocks.js';
import { parseCsvRows } from './redirects.js';
import { importWordPress, type WordPressImportOptions } from './wordpress-import.js';
import { parseWxr } from './wxr.js';

// Importers read files that strangers can write. These tests feed them hostile input and check
// that they stay quick, keep their limits and never turn the input into something that runs.

function timed<T>(run: () => T, maxMs = 2000): T {
  const started = Date.now();
  const result = run();
  expect(Date.now() - started).toBeLessThan(maxMs);
  return result;
}

const WXR_HEAD = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>Hostile</title><link>https://old.example.com</link>`;

function item(id: number, fields: Record<string, string> = {}): string {
  const f = {
    title: `Item ${id}`,
    content: '<p>Hi</p>',
    name: `item-${id}`,
    status: 'publish',
    parent: '0',
    type: 'post',
    ...fields,
  };
  return `<item><title><![CDATA[${f.title}]]></title><content:encoded><![CDATA[${f.content}]]></content:encoded><wp:post_id>${id}</wp:post_id><wp:post_date_gmt>2024-01-01 00:00:00</wp:post_date_gmt><wp:post_name><![CDATA[${f.name}]]></wp:post_name><wp:status>${f.status}</wp:status><wp:post_parent>${f.parent}</wp:post_parent><wp:post_type>${f.type}</wp:post_type></item>`;
}

const wxr = (...items: string[]) => `${WXR_HEAD}${items.join('\n')}</channel></rss>`;

describe('WXR reader', () => {
  it('does not expand entities declared in a DOCTYPE', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE rss [
      <!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
      <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
      <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
      <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
    ]><rss><channel><title>&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;</title></channel></rss>`;
    const parsed = timed(() => parseWxr(bomb));
    expect(parsed.title.length).toBeLessThan(1000);
  });

  it('stays quick on long runs of unterminated markup', () => {
    for (const junk of [
      '<![CDATA[' + 'x'.repeat(2_000_000),
      '<wp:post_id>'.repeat(50_000),
      '<item>'.repeat(20_000),
      '<!--' + '-'.repeat(1_000_000),
      '<a ' + '"'.repeat(100_001),
      '<!--'.repeat(200_000),
      '<p'.repeat(200_000),
    ]) {
      timed(() => {
        try {
          parseWxr(`${WXR_HEAD}${junk}`);
        } catch {
          // Refusing the file is fine; hanging is not.
        }
      });
    }
  });
});

describe('HTML to blocks', () => {
  it('stays quick on hostile markup', () => {
    for (const html of [
      '<a ' + '"'.repeat(100_001),
      '<p'.repeat(100_000),
      '<div>'.repeat(50_000),
      '<a href="' + 'x'.repeat(2_000_000),
      '&#' + '9'.repeat(100_000) + ';',
      '<img src=' + "'".repeat(100_001),
      '<!--'.repeat(200_000),
      '<a "x'.repeat(100_000),
      '<a href=\'x'.repeat(100_000),
    ]) {
      timed(() => htmlToBlocks(html));
    }
  });

  it('never keeps scripts, event handlers, frames or unsafe link and image addresses', () => {
    const blocks = htmlToBlocks(
      [
        '<p onclick="steal()">a <a href="javascript:alert(1)">b</a> <a href=" jAvA\tscript:alert(2)">c</a></p>',
        '<p><a href="data:text/html;base64,PHNjcmlwdD4=">d</a> <a href="vbscript:x">e</a></p>',
        '<img src="javascript:alert(3)" onerror="alert(4)" alt="x">',
        '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x">',
        '<script>alert(5)</script><style>body{display:none}</style>',
        '<svg onload="alert(6)"><script>alert(7)</script></svg>',
      ].join('\n'),
    );
    const json = JSON.stringify(blocks).toLowerCase();
    for (const bad of [
      'javascript:',
      'vbscript:',
      'data:text',
      'onclick',
      'onerror',
      'onload',
      'iframe',
      '<script',
      'alert(',
    ]) {
      expect(json).not.toContain(bad);
    }
  });
});

describe('WordPress import', () => {
  function harness() {
    const records = new Map<number, ContentRecord>();
    let nextId = 1;
    const options: WordPressImportOptions = {
      content: {
        async create(input) {
          const record = {
            id: nextId++,
            type: input.type,
            status: input.status ?? 'draft',
            title: input.title ?? '',
            slug: input.slug ?? 'x',
            body: input.body ?? [],
            excerpt: input.excerpt ?? null,
            authorId: input.authorId ?? null,
            parentId: input.parentId ?? null,
            publishedAt: input.publishedAt ?? null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          } as ContentRecord;
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
        async getTermBySlug() {
          return undefined;
        },
        async createTerm(input) {
          return { id: 1, taxonomy: input.taxonomy, slug: input.slug, name: input.name } as never;
        },
        async setContentTerms() {
          return [] as never;
        },
      },
      permalinks: {
        async pathFor(content) {
          return `/${content.slug}`;
        },
      },
      meta: { async setMeta() {} },
    };
    return { options, records };
  }

  it('survives pages that are each other’s parent, and a parent that does not exist', async () => {
    const h = harness();
    const started = Date.now();
    await importWordPress(
      wxr(
        item(1, { type: 'page', parent: '2', name: 'a' }),
        item(2, { type: 'page', parent: '1', name: 'b' }),
        item(3, { type: 'page', parent: '3', name: 'self' }),
        item(4, { type: 'page', parent: '999', name: 'orphan' }),
      ),
      h.options,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(h.records.size).toBe(4);
  });

  it('imports a very large export without hanging', async () => {
    const h = harness();
    const items = Array.from({ length: 5000 }, (_, i) => item(i + 1));
    const started = Date.now();
    await importWordPress(wxr(...items), h.options);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(h.records.size).toBeGreaterThan(0);
  });

  it('keeps hostile titles as text and never lets content carry executable markup', async () => {
    const h = harness();
    await importWordPress(
      wxr(
        item(1, {
          title: '<img src=x onerror=alert(1)>',
          name: '../../etc/passwd',
          content:
            '<p>x</p><script>alert(1)</script><a href="javascript:alert(2)">y</a><img src="javascript:alert(3)" onerror="alert(4)">',
        }),
        item(2, { name: '__proto__', title: 'proto' }),
      ),
      h.options,
    );
    const [first] = [...h.records.values()];
    // The title is stored as plain text (it is escaped when drawn) and the body is blocks.
    expect(first!.title).toBe('<img src=x onerror=alert(1)>');
    const body = JSON.stringify(first!.body).toLowerCase();
    for (const bad of ['javascript:', 'onerror', '<script', 'alert(']) {
      expect(body).not.toContain(bad);
    }
    expect(first!.slug).not.toContain('/');
    expect(first!.slug).not.toContain('..');
  });
});

describe('redirect CSV reader', () => {
  it('stays quick on hostile files', () => {
    for (const csv of [
      '"' + 'a,'.repeat(300_000),
      '"""'.repeat(200_000),
      'a,b\n'.repeat(200_000),
      '\u0000,\u0001\r\r\r\r' + '\r'.repeat(100_000),
      ','.repeat(1_000_000),
    ]) {
      timed(() => {
        try {
          parseCsvRows(csv);
        } catch {
          // A file that cannot be read is refused with a message; that is fine.
        }
      });
    }
  });
});

describe('backup import', () => {
  const emptyDeps = (): BackupDeps => {
    const created: Array<Record<string, unknown>> = [];
    const settings: Record<string, unknown> = {};
    return {
      content: {
        async list() {
          return [];
        },
        async create(input: Record<string, unknown>) {
          created.push(input);
          return { id: created.length } as never;
        },
        async update() {
          return {} as never;
        },
      } as never,
      taxonomies: {
        listTaxonomies: () => [{ name: 'category' }],
        async listTerms() {
          return [];
        },
        async createTerm() {
          return { id: 1 } as never;
        },
        async getTermBySlug() {
          return undefined;
        },
        async getContentTerms() {
          return [];
        },
        async setContentTerms() {
          return [] as never;
        },
      } as never,
      settings: {
        async getAll() {
          return settings as never;
        },
        async update(patch: Record<string, unknown>) {
          Object.assign(settings, patch);
          return settings as never;
        },
      } as never,
      meta: {
        async getMetaMany() {
          return new Map();
        },
        async setMeta() {},
      },
    };
  };

  const base = (over: Record<string, unknown> = {}) => ({
    format: 'nodepress-export',
    version: 1,
    exportedAt: '2026-01-01T00:00:00Z',
    settings: {},
    terms: [],
    content: [],
    authors: [],
    ...over,
  });

  const post = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    type: 'post',
    status: 'draft',
    title: 't',
    slug: `t${id}`,
    body: [],
    excerpt: null,
    authorId: null,
    parentId: null,
    publishedAt: null,
    createdAt: 'x',
    updatedAt: 'x',
    meta: {},
    terms: {},
    ...over,
  });

  it('does not pollute prototypes through keys such as __proto__ in settings, fields or terms', async () => {
    const settings = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"site_title":"Ok"}',
    ) as Record<string, unknown>;
    const content = [
      post(1, {
        meta: JSON.parse('{"__proto__":{"polluted":"yes"},"subtitle":"s"}'),
        terms: JSON.parse('{"__proto__":["a"],"category":[]}'),
      }),
    ];
    await importSite(JSON.parse(JSON.stringify(base({ settings, content }))), emptyDeps(), {
      defaultAuthorId: 1,
    }).catch(() => undefined);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('refuses wrong types, oversized lists and ids that are not integers, and changes nothing', async () => {
    const deps = emptyDeps();
    const bad: unknown[] = [
      base({ content: [{ id: '1' }] }),
      base({ content: new Array(100_001).fill({}) }),
      base({
        terms: [
          { id: 1.5, taxonomy: 't', name: 'n', slug: 's', description: null, parentId: null },
        ],
      }),
      base({ settings: [] }),
      JSON.parse('{"__proto__":{"format":"nodepress-export"}}'),
    ];
    for (const file of bad) {
      await expect(importSite(file, deps)).rejects.toThrow(/not a NodePress export/);
    }
  });

  it('survives very deep and very large content bodies', async () => {
    let body: unknown = [];
    for (let i = 0; i < 5000; i++) body = [{ type: 'core/columns', children: body }];
    const big = Array.from({ length: 20_000 }, (_, i) => ({
      type: 'core/paragraph',
      content: [{ text: `p${i}` }],
    }));
    const file = base({ content: [post(1, { body }), post(2, { body: big })] });
    const started = Date.now();
    const summary = await importSite(file, emptyDeps(), { defaultAuthorId: 1 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(summary.content + summary.skipped.length).toBe(2);
  });

  it('does not export anything that looks like a secret', async () => {
    const exported = JSON.stringify(await exportSite(emptyDeps()));
    expect(exported).not.toMatch(/password|secret|token|hash/i);
  });
});
