import type { TemplateProps } from '@nodepress/core';
import { describe, expect, it } from 'vitest';
import NotFound from './404.js';
import Front from './front.js';
import Index from './index.js';
import Page from './page.js';
import Single from './single.js';

type Item = NonNullable<TemplateProps['content']>;
const theme = { name: 'aurora', version: '0.1.0', assetsUrl: '/themes/aurora/assets' };
const base: TemplateProps = { siteName: 'My <Site>', path: '/blog/hi', status: 200, theme };
const post = (title: string, extra: Partial<Item> = {}): Item =>
  ({
    title,
    excerpt: null,
    publishedAt: new Date('2026-03-04T10:00:00Z'),
    ...extra,
  }) as Item;

async function render(node: unknown): Promise<string> {
  return String(await (node as { toString(): string | Promise<string> }).toString());
}

describe('Aurora page frame', () => {
  it('has a language, a skip link, one main landmark and the stylesheet', async () => {
    const html = await render(Single({ ...base, content: post('Hello') }));
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('href="#main"');
    expect(html.match(/<main /g)).toHaveLength(1);
    expect(html).toContain('id="main"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain('href="/themes/aurora/assets/style.css"');
    expect(html).toContain('<nav aria-label="Primary">');
  });

  it('escapes text but keeps trusted body HTML', async () => {
    const html = await render(
      Single({
        ...base,
        content: post('Hello <b>', { excerpt: 'A & B' }),
        html: '<p>Body</p>',
      }),
    );
    expect(html).toContain('<h1>Hello &lt;b&gt;</h1>');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('<p>Body</p>');
    expect(html).toContain('<title>Hello &lt;b&gt; | My &lt;Site&gt;</title>');
    expect(html).toContain('<time class="np-aurora-date" datetime="2026-03-04">');
  });

  it('draws pages without a date, and the 404 with the path as text', async () => {
    const page = await render(Page({ ...base, content: post('About') }));
    expect(page).toContain('<h1>About</h1>');
    expect(page).not.toContain('<time');
    const missing = await render(NotFound({ ...base, status: 404, path: '/<script>' }));
    expect(missing).toContain('Page not found');
    expect(missing).toContain('&lt;script&gt;');
    expect(missing).not.toContain('<script>');
  });

  it('index falls back to the 404 or single template by status', async () => {
    expect(await render(Index({ ...base, status: 404 }))).toContain('Page not found');
    expect(await render(Index({ ...base, content: post('T') }))).toContain('<h1>T</h1>');
  });
});

describe('Aurora front page', () => {
  const posts = [
    { content: post('First <post>', { excerpt: 'Intro' }), url: '/blog/first' },
    { content: post('Second'), url: '/blog/second' },
  ];
  const front: TemplateProps = {
    ...base,
    path: '/',
    tagline: 'Just "words"',
    html: '<p>Welcome</p>',
    posts,
  };

  it('blog layout (default): site title, tagline, intro and the post list', async () => {
    const html = await render(Front({ ...front, settings: { layout: 'blog' } }));
    expect(html).toContain('<title>My &lt;Site&gt;</title>');
    expect(html).toContain('<h1 class="np-aurora-site-title">My &lt;Site&gt;</h1>');
    expect(html).toContain('<p>Welcome</p>');
    expect(html).toContain('<a href="/blog/first">First &lt;post&gt;</a>');
    expect(html).toContain('class="np-aurora-posts"');
    expect(html).not.toContain('np-aurora-hero');
    expect(html).toContain('name="description" content="Just &quot;words&quot;"');
  });

  it('business layout: hero with the tagline and the news as cards', async () => {
    const html = await render(Front({ ...front, settings: { layout: 'business' } }));
    expect(html).toContain('np-aurora-hero');
    expect(html).toContain('Latest news');
    expect(html).toContain('class="np-aurora-cards"');
    expect(html).toContain('Just &quot;words&quot;');
  });

  it('falls back to the blog layout and shows an empty state', async () => {
    const html = await render(Front({ ...front, settings: undefined, posts: [] } as TemplateProps));
    expect(html).toContain('Latest posts');
    expect(html).toContain('No posts yet.');
  });

  it('uses one h1 and headings in order on both layouts', async () => {
    for (const layout of ['blog', 'business']) {
      const html = await render(Front({ ...front, settings: { layout } }));
      expect(html.match(/<h1[ >]/g), layout).toHaveLength(1);
      const levels = [...html.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
      levels.forEach((level, i) => {
        if (i > 0) expect(level - (levels[i - 1] ?? 0), layout).toBeLessThanOrEqual(1);
      });
    }
  });
});
