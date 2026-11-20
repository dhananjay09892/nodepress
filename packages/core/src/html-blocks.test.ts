import { describe, expect, it } from 'vitest';
import { htmlToBlocks, mapBlockUrls, safeHref } from './html-blocks.js';

describe('htmlToBlocks', () => {
  it('converts paragraphs with inline marks and links', () => {
    expect(
      htmlToBlocks(
        '<p>Hi <strong>bold <em>both</em></strong> and <a href="/x?a=1#h">link</a>.</p>',
      ),
    ).toEqual([
      {
        type: 'core/paragraph',
        content: [
          { text: 'Hi ' },
          { text: 'bold ', marks: [{ type: 'bold' }] },
          { text: 'both', marks: [{ type: 'bold' }, { type: 'italic' }] },
          { text: ' and ' },
          { text: 'link', marks: [{ type: 'link', href: '/x?a=1#h' }] },
          { text: '.' },
        ],
      },
    ]);
  });

  it('converts headings, lists, quotes, code and images', () => {
    const blocks = htmlToBlocks(
      '<h2>Title</h2><ol><li>One</li><li>Two <b>2</b></li></ol><blockquote><p>Said</p></blockquote>' +
        '<pre><code>a &lt; b\n  c</code></pre><p><img src="https://x.test/a.png" alt="A"></p>',
    );
    expect(blocks).toEqual([
      { type: 'core/heading', attrs: { level: 2 }, content: [{ text: 'Title' }] },
      {
        type: 'core/list',
        attrs: { ordered: true },
        children: [
          { type: 'core/list-item', content: [{ text: 'One' }] },
          {
            type: 'core/list-item',
            content: [{ text: 'Two ' }, { text: '2', marks: [{ type: 'bold' }] }],
          },
        ],
      },
      { type: 'core/quote', content: [{ text: 'Said' }] },
      { type: 'core/code', content: [{ text: 'a < b\n  c' }] },
      { type: 'core/image', attrs: { src: 'https://x.test/a.png', alt: 'A' } },
    ]);
  });

  it('drops scripts, styles, comments and unsafe links', () => {
    const blocks = htmlToBlocks(
      '<!-- wp:paragraph --><p>A<script>alert(1)</script><style>p{}</style> <a href="javascript:alert(1)">b</a></p><!-- /wp:paragraph -->',
    );
    expect(blocks).toEqual([{ type: 'core/paragraph', content: [{ text: 'A b' }] }]);
    expect(safeHref('javascript:x')).toBeUndefined();
    expect(safeHref(' https://a.test ')).toBe('https://a.test');
    expect(safeHref('page/2')).toBe('page/2');
  });

  it('reads classic content: blank lines split paragraphs, newlines stay', () => {
    expect(htmlToBlocks('One\nstill one\n\nTwo &amp; three')).toEqual([
      { type: 'core/paragraph', content: [{ text: 'One\nstill one' }] },
      { type: 'core/paragraph', content: [{ text: 'Two & three' }] },
    ]);
    expect(htmlToBlocks('Hi <b>there</b>\n\nBye')).toEqual([
      {
        type: 'core/paragraph',
        content: [{ text: 'Hi ' }, { text: 'there', marks: [{ type: 'bold' }] }],
      },
      { type: 'core/paragraph', content: [{ text: 'Bye' }] },
    ]);
  });

  it('keeps text that sits outside any block, tolerates broken markup, and handles empties', () => {
    expect(htmlToBlocks('')).toEqual([]);
    expect(htmlToBlocks('   ')).toEqual([]);
    expect(htmlToBlocks('<div>loose <b>text</div><p>next</p>')).toEqual([
      {
        type: 'core/paragraph',
        content: [{ text: 'loose ' }, { text: 'text', marks: [{ type: 'bold' }] }],
      },
      { type: 'core/paragraph', content: [{ text: 'next' }] },
    ]);
    expect(() => htmlToBlocks('<p><a href="x">unclosed')).not.toThrow();
  });

  it('does not blow up on deep nesting or huge input', () => {
    expect(() => htmlToBlocks('<div>'.repeat(5000) + 'x' + '</div>'.repeat(5000))).not.toThrow();
    expect(htmlToBlocks('<p>x</p>'.repeat(6000)).length).toBeLessThanOrEqual(5000);
  });
});

describe('mapBlockUrls', () => {
  it('rewrites link marks and image sources, including nested blocks', () => {
    const blocks = mapBlockUrls(
      [
        { type: 'core/paragraph', content: [{ text: 'a', marks: [{ type: 'link', href: '/a' }] }] },
        {
          type: 'core/list',
          children: [
            {
              type: 'core/list-item',
              content: [{ text: 'b', marks: [{ type: 'link', href: '/b' }] }],
            },
          ],
        },
        { type: 'core/image', attrs: { src: '/i.png', alt: '' } },
      ],
      (url, kind) => `${kind}:${url}`,
    );
    expect(JSON.stringify(blocks)).toContain('"href":"link:/a"');
    expect(JSON.stringify(blocks)).toContain('"href":"link:/b"');
    expect(JSON.stringify(blocks)).toContain('"src":"image:/i.png"');
  });
});
