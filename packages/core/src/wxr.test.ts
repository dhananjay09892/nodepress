import { describe, expect, it } from 'vitest';
import { parseWxr, WxrError } from './wxr.js';
import { WXR_FIXTURE } from './testing/wxr-fixture.js';

describe('parseWxr', () => {
  const wxr = parseWxr(WXR_FIXTURE);

  it('reads the site, authors and terms', () => {
    expect(wxr.title).toBe('Old & Gold');
    expect(wxr.siteUrl).toBe('https://old.example.com');
    expect(wxr.authors).toEqual([
      { login: 'jane', email: 'jane@example.com', displayName: 'Jane Doe' },
    ]);
    expect(wxr.categories.map((c) => [c.slug, c.name, c.parent])).toEqual([
      ['travel-italy', 'Italy', 'travel'],
      ['travel', 'Travel', undefined],
    ]);
    expect(wxr.categories[1]?.description).toBe('Trips');
    expect(wxr.tags).toEqual([{ id: 5, slug: 'rome', name: 'Rome' }]);
  });

  it('reads items with CDATA, meta, comments and term attributes', () => {
    expect(wxr.items.map((i) => [i.type, i.id, i.status])).toEqual([
      ['page', 10, 'publish'],
      ['page', 11, 'publish'],
      ['post', 20, 'publish'],
      ['post', 21, 'draft'],
      ['post', 22, 'future'],
      ['attachment', 30, 'inherit'],
      ['product', 40, 'publish'],
    ]);
    const post = wxr.items[2]!;
    expect(post.slug).toBe('hello-rome');
    expect(post.content).toContain('<a href="/about/">about</a>');
    expect(post.content).toContain('<script>alert(1)</script>');
    expect(post.terms).toEqual([
      { taxonomy: 'category', slug: 'travel-italy', name: 'Italy' },
      { taxonomy: 'tag', slug: 'rome', name: 'Rome' },
      { taxonomy: 'tag', slug: 'new-tag', name: 'New Tag' },
      { taxonomy: 'series', slug: 's1', name: 'Series 1' },
    ]);
    expect(post.meta['_thumbnail_id']).toBe('30');
    expect(post.comments).toEqual([
      {
        id: 1,
        author: 'Bob',
        authorEmail: 'bob@example.com',
        date: '2024-05-02 10:00:00',
        content: 'Nice!',
        approved: '1',
      },
    ]);
    expect(wxr.items[1]?.parent).toBe(10);
    expect(wxr.items[5]?.attachmentUrl).toBe('https://old.example.com/wp-content/uploads/rome.jpg');
  });

  it('decodes entities and keeps literal item tags inside CDATA in place', () => {
    const xml = `<rss><channel><title>A &amp; B &#233; &#x41;</title><link>http://x.test/</link>
      <item><title>T</title><content:encoded><![CDATA[<item>not an item</item>]]></content:encoded>
      <wp:post_id>1</wp:post_id><wp:post_type>post</wp:post_type><wp:status>draft</wp:status></item>
      <item><title>U</title><wp:post_id>2</wp:post_id><wp:post_type>post</wp:post_type><wp:status>draft</wp:status></item>
      </channel></rss>`;
    const parsed = parseWxr(xml);
    expect(parsed.title).toBe('A & B é A');
    expect(parsed.siteUrl).toBe('http://x.test');
    expect(parsed.items.map((i) => [i.id, i.content])).toEqual([
      [1, '<item>not an item</item>'],
      [2, ''],
    ]);
  });

  it.each([
    ['', /empty/],
    ['<html></html>', /not a WordPress export/],
    ['<rss><channel><item></channel></rss>', /Unexpected closing/],
    ['<rss><channel>', /never closed/],
    ['<rss><channel><![CDATA[x</channel></rss>', /CDATA/],
  ])('rejects %j', (xml, message) => {
    expect(() => parseWxr(xml)).toThrow(WxrError);
    expect(() => parseWxr(xml)).toThrow(message);
  });

  it('refuses very deep nesting', () => {
    const xml = `<rss><channel>${'<a>'.repeat(100)}${'</a>'.repeat(100)}</channel></rss>`;
    expect(() => parseWxr(xml)).toThrow(/nested too deeply/);
  });
});
