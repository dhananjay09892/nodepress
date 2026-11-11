import { describe, expect, it } from 'vitest';
import {
  BlockRegistry,
  createBlockRegistry,
  escapeHtml,
  renderBlocks,
  safeUrl,
  validateDocument,
  type Block,
  type BlockDocument,
} from './index.js';

const doc = (...blocks: Block[]): BlockDocument => ({ version: 1, blocks });
const t = (text: string, marks?: NonNullable<Block['content']>[number]['marks']) =>
  marks ? { text, marks } : { text };
const render = (...blocks: Block[]) => renderBlocks(doc(...blocks), createBlockRegistry());

describe('safeUrl and escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
  it('allows http(s), mailto, tel and relative URLs', () => {
    for (const u of ['https://a.test/x?y=1', 'http://a.test', 'mailto:a@b.test', 'tel:+123', '/about', '#top', 'a/b', './c']) {
      expect(safeUrl(u)).toBe(u);
    }
  });
  it('blocks script-capable and malformed URLs', () => {
    for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.test', '', '  ', 42, undefined]) {
      expect(safeUrl(u)).toBeUndefined();
    }
  });
});

describe('core blocks render', () => {
  it('paragraph with marks and escaping', () => {
    expect(
      render({
        type: 'core/paragraph',
        content: [t('a <b> '), t('bold', [{ type: 'bold' }]), t(' link', [{ type: 'link', href: 'https://x.test' }])],
      }),
    ).toBe('<p>a &lt;b&gt; <strong>bold</strong><a href="https://x.test" rel="noopener noreferrer"> link</a></p>');
  });
  it('unsafe links degrade to plain text', () => {
    expect(render({ type: 'core/paragraph', content: [t('x', [{ type: 'link', href: 'javascript:alert(1)' }])] })).toBe('<p>x</p>');
  });
  it('heading levels', () => {
    expect(render({ type: 'core/heading', attrs: { level: 3 }, content: [t('Hi')] })).toBe('<h3>Hi</h3>');
  });
  it('image with caption, media resolution and escaping', () => {
    const html = renderBlocks(
      doc({ type: 'core/image', attrs: { mediaId: 'm1', alt: 'a "b"', caption: '<c>', width: 10, height: 5 } }),
      createBlockRegistry(),
      { resolveMediaUrl: (id) => (id === 'm1' ? '/uploads/m1.webp' : undefined) },
    );
    expect(html).toBe(
      '<figure><img src="/uploads/m1.webp" alt="a &quot;b&quot;" loading="lazy" width="10" height="5"><figcaption>&lt;c&gt;</figcaption></figure>',
    );
  });
  it('image with unsafe src renders nothing', () => {
    expect(render({ type: 'core/image', attrs: { src: 'javascript:x', alt: '' } })).toBe('');
  });
  it('ordered and nested lists', () => {
    const html = render({
      type: 'core/list',
      attrs: { ordered: true },
      children: [
        {
          type: 'core/list-item',
          content: [t('one')],
          children: [{ type: 'core/list', children: [{ type: 'core/list-item', content: [t('inner')] }] }],
        },
      ],
    });
    expect(html).toBe('<ol><li>one<ul><li>inner</li></ul></li></ol>');
  });
  it('quote with citation', () => {
    expect(render({ type: 'core/quote', attrs: { citation: 'Me' }, content: [t('Hi')] })).toBe(
      '<blockquote><p>Hi</p><cite>Me</cite></blockquote>',
    );
  });
  it('code escapes content and sanitises language', () => {
    expect(render({ type: 'core/code', attrs: { language: 'TS' }, content: [t('a<b')] })).toBe(
      '<pre><code class="language-ts">a&lt;b</code></pre>',
    );
    expect(render({ type: 'core/code', attrs: { language: '"><script>' }, content: [t('x')] })).toBe('<pre><code>x</code></pre>');
  });
  it('embed: allowlisted providers become iframes, others links', () => {
    expect(render({ type: 'core/embed', attrs: { url: 'https://www.youtube.com/watch?v=abcdefghijk' } })).toContain(
      'src="https://www.youtube-nocookie.com/embed/abcdefghijk"',
    );
    expect(render({ type: 'core/embed', attrs: { url: 'https://vimeo.com/123456' } })).toContain(
      'src="https://player.vimeo.com/video/123456"',
    );
    const other = render({ type: 'core/embed', attrs: { url: 'https://evil.test/<x>' } });
    expect(other).not.toContain('<iframe');
    expect(other).toContain('<a href=');
    expect(render({ type: 'core/embed', attrs: { url: 'javascript:alert(1)' } })).toBe('');
  });
  it('columns render nested blocks', () => {
    const html = render({
      type: 'core/columns',
      children: [
        { type: 'core/column', children: [{ type: 'core/paragraph', content: [t('L')] }] },
        { type: 'core/column', children: [{ type: 'core/paragraph', content: [t('R')] }] },
      ],
    });
    expect(html).toBe(
      '<div class="np-columns np-columns-2"><div class="np-column"><p>L</p></div><div class="np-column"><p>R</p></div></div>',
    );
  });
  it('button', () => {
    expect(render({ type: 'core/button', attrs: { text: 'Go', href: '/x', style: 'outline' } })).toBe(
      '<p class="np-button-wrap"><a class="np-button np-button-outline" href="/x">Go</a></p>',
    );
    expect(render({ type: 'core/button', attrs: { text: 'Go', href: 'javascript:x' } })).toBe('');
  });
});

describe('registry and error isolation', () => {
  it('rejects bad and duplicate names', () => {
    const r = new BlockRegistry();
    expect(() => r.register({ name: 'Bad', title: 'x', render: () => '' })).toThrow(/Invalid block name/);
    r.register({ name: 'acme/hero', title: 'Hero', render: () => '<hr>' });
    expect(() => r.register({ name: 'acme/hero', title: 'Hero', render: () => '' })).toThrow(/already registered/);
  });
  it('plugins can add blocks', () => {
    const r = createBlockRegistry().register({ name: 'acme/hero', title: 'Hero', render: () => '<hr>' });
    expect(renderBlocks(doc({ type: 'acme/hero' }), r)).toBe('<hr>');
  });
  it('a throwing or unknown block is skipped and reported, others still render', () => {
    const r = createBlockRegistry().register({
      name: 'acme/boom',
      title: 'Boom',
      render: () => {
        throw new Error('boom');
      },
    });
    const errors: string[] = [];
    const html = renderBlocks(
      doc(
        { type: 'core/paragraph', content: [t('a')] },
        { type: 'acme/boom' },
        { type: 'nope/missing' },
        { type: 'core/paragraph', content: [t('b')] },
      ),
      r,
      { onError: (e) => errors.push(e.message) },
    );
    expect(html).toBe('<p>a</p><p>b</p>');
    expect(errors).toEqual(['boom', 'Unknown block type "nope/missing"']);
  });
  it('stops at excessive nesting', () => {
    let block: Block = { type: 'core/paragraph', content: [t('deep')] };
    for (let i = 0; i < 20; i++) block = { type: 'core/column', children: [block] };
    expect(render(block)).not.toContain('deep');
  });
});

describe('validateDocument', () => {
  const r = createBlockRegistry();
  it('accepts a valid document', () => {
    expect(
      validateDocument(
        doc(
          { type: 'core/heading', attrs: { level: 2 }, content: [t('x')] },
          { type: 'core/image', attrs: { src: '/a.png', alt: '' } },
        ),
        r,
      ),
    ).toEqual([]);
  });
  it('rejects a wrong envelope', () => {
    expect(validateDocument({ blocks: [] }, r)).toHaveLength(1);
    expect(validateDocument(null, r)).toHaveLength(1);
  });
  it('reports paths for invalid blocks', () => {
    const issues = validateDocument(
      doc(
        { type: 'core/paragraph' },
        { type: 'core/heading', attrs: { level: 9 } },
        { type: 'core/image', attrs: { src: '/a.png' } },
        { type: 'core/columns', children: [{ type: 'core/column' }] },
        { type: 'core/button', attrs: { text: 'x', href: 'javascript:1' } },
        { type: 'core/embed', attrs: { url: 'ftp://x' } },
        { type: 'x/unknown' },
      ),
      r,
    );
    expect(issues.map((i) => i.path)).toEqual(['blocks[1]', 'blocks[2]', 'blocks[3]', 'blocks[4]', 'blocks[5]', 'blocks[6]']);
  });
  it('rejects malformed content and deep nesting', () => {
    expect(validateDocument(doc({ type: 'core/paragraph', content: [{ text: 1 } as never] }), r)).toHaveLength(1);
    let block: Block = { type: 'core/paragraph' };
    for (let i = 0; i < 12; i++) block = { type: 'core/column', children: [block] };
    expect(validateDocument(doc(block), r).some((i) => i.message.includes('nested deeper'))).toBe(true);
  });
});
