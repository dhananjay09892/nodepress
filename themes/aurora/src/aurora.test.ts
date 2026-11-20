import type { TemplateProps } from '@nodepress/core';
import { describe, expect, it } from 'vitest';
import NotFound from './404.js';
import Front from './front.js';
import Index from './index.js';
import { customCss, jsonLdScript } from './layout.js';
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

  it('draws the assigned menus, marks the current page and escapes labels', async () => {
    const primary = [
      { label: 'Home', url: '/', children: [] },
      {
        label: 'Blog <b>',
        url: '/blog/hi',
        children: [
          { label: 'Docs', url: 'https://example.com', target: '_blank' as const, children: [] },
        ],
      },
    ];
    const html = await render(
      Single({
        ...base,
        content: post('Hello'),
        menus: { primary, footer: [{ label: 'Contact', url: '/contact', children: [] }] },
      }),
    );
    expect(html).toContain('<ul class="np-aurora-menu">');
    expect(html).toContain('<a href="/blog/hi" aria-current="page">Blog &lt;b&gt;</a>');
    expect(html).not.toContain('<a href="/" aria-current');
    expect(html).toContain('<ul class="np-aurora-submenu">');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('<nav aria-label="Footer">');
    expect(html).toContain('>Contact</a>');
  });

  it('falls back to a Home link and no footer menu when none is assigned', async () => {
    const html = await render(Single({ ...base, content: post('Hello'), menus: {} }));
    expect(html).toContain('>Home</a>');
    expect(html).not.toContain('np-aurora-menu"');
    expect(html).not.toContain('aria-label="Footer"');
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
    const html = await render(Front({ ...base, path: '/', posts: [] }));
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

describe('Aurora sidebar widgets', () => {
  const widgets = {
    sidebar: [
      { id: 'w1', type: 'text', title: 'About <us>', html: '<p>Trusted <b>html</b></p>' },
      { id: 'w2', type: 'recent-posts', html: '<ul><li><a href="/blog/a">A</a></li></ul>' },
    ],
  };

  it('draws the widgets in a labelled aside next to the main landmark', async () => {
    const html = await render(Single({ ...base, content: post('Hello'), widgets }));
    expect(html).toContain('<aside class="np-aurora-sidebar" aria-label="Sidebar">');
    expect(html.match(/<main /g)).toHaveLength(1);
    expect(html).toContain('<h2 class="np-aurora-widget-title">About &lt;us&gt;</h2>');
    expect(html).toContain('<p>Trusted <b>html</b></p>');
    expect(html).toContain('np-aurora-widget-recent-posts');
    // A widget without a title has no empty heading.
    expect(html.match(/np-aurora-widget-title/g)).toHaveLength(1);
  });

  it('keeps the plain layout when the sidebar has no widgets', async () => {
    for (const w of [undefined, {}, { sidebar: [] }]) {
      const html = await render(
        Single({ ...base, content: post('Hello'), ...(w ? { widgets: w } : {}) }),
      );
      expect(html).not.toContain('<aside');
      expect(html).toContain('<main id="main" class="np-aurora-wrap np-aurora-main"');
    }
  });
});

describe('Aurora customizer settings', () => {
  it('adds no CSS for the defaults', () => {
    expect(customCss(undefined)).toBe('');
    expect(customCss({ accent: '#0b5cad', font: 'system' })).toBe('');
  });

  it('turns a hex accent and a known font into CSS, keeping dark mode links readable', () => {
    const css = customCss({ accent: '#aa0000', font: 'serif' });
    expect(css).toContain(':root{--link:#aa0000;--focus:#aa0000}');
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('body.np-aurora{font-family:Georgia');
  });

  it('never lets anything but a hex colour or a known font into the stylesheet', () => {
    expect(customCss({ accent: 'red;}</style><script>', font: 'x;}body{' })).toBe('');
    expect(customCss({ accent: 5, font: 5 })).toBe('');
  });

  it('puts the CSS and the logo in the page', async () => {
    const html = await render(
      Single({
        ...base,
        content: post('Hello'),
        settings: { accent: '#aa0000', font: 'mono', logo: '/media/logo.png' },
      }),
    );
    expect(html).toContain('<style>:root{--link:#aa0000');
    expect(html).toContain('<img class="np-aurora-logo" src="/media/logo.png" alt=""');
    const plain = await render(Single({ ...base, content: post('Hello'), settings: { logo: '' } }));
    expect(plain).not.toContain('<style>');
    expect(plain).not.toContain('np-aurora-logo');
  });
});

describe('Aurora SEO tags', () => {
  const meta: NonNullable<TemplateProps['meta']> = {
    description: 'About "this" <post>',
    canonical: 'https://example.com/blog/hi?a=1&b=2',
    feedUrl: 'https://example.com/feed.xml',
    og: {
      title: 'Hi <b>',
      description: 'About "this" <post>',
      type: 'article',
      url: 'https://example.com/blog/hi?a=1&b=2',
      siteName: 'My <Site>',
      image: 'https://example.com/uploads/a.png',
    },
  };

  it('draws the description, canonical link, feed link and Open Graph tags, escaped', async () => {
    const html = await render(Single({ ...base, content: post('Hi'), meta }));
    expect(html).toContain('name="description" content="About &quot;this&quot; &lt;post&gt;"');
    expect(html).toContain('<link rel="canonical" href="https://example.com/blog/hi?a=1&amp;b=2"');
    expect(html).toContain('rel="alternate" type="application/rss+xml"');
    expect(html).toContain('href="https://example.com/feed.xml"');
    expect(html).toContain('property="og:title" content="Hi &lt;b&gt;"');
    expect(html).toContain('property="og:type" content="article"');
    expect(html).toContain('property="og:url" content="https://example.com/blog/hi?a=1&amp;b=2"');
    expect(html).toContain('property="og:site_name" content="My &lt;Site&gt;"');
    expect(html).toContain('property="og:image" content="https://example.com/uploads/a.png"');
    expect(html).not.toContain('<b>');
  });

  it('leaves out the canonical link, og:url, og:image and feed link when they are not set', async () => {
    const { canonical, feedUrl, ...rest } = meta;
    void canonical;
    void feedUrl;
    const { url, image, ...og } = rest.og;
    void url;
    void image;
    const html = await render(NotFound({ ...base, status: 404, meta: { ...rest, og } }));
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('og:url');
    expect(html).not.toContain('og:image');
    expect(html).not.toContain('application/rss+xml');
    expect(html).toContain('property="og:title"');
  });

  it('draws no Open Graph tags without meta, and the description falls back to the tagline', async () => {
    const html = await render(Single({ ...base, content: post('Hi'), tagline: 'Tag' }));
    expect(html).not.toContain('og:title');
    expect(html).toContain('name="description" content="Tag"');
  });
});

describe('Aurora SEO plugin output', () => {
  const meta: NonNullable<TemplateProps['meta']> = {
    title: 'Better <title> | My Site',
    robots: 'noindex, follow',
    jsonLd: [{ '@type': 'Article', headline: '</script><script>alert(1)</script>' }],
    description: 'd',
    og: { title: 't', description: 'd', type: 'article', siteName: 'My Site' },
  };

  it('uses the title and robots from meta, and draws JSON-LD that cannot close the tag', async () => {
    const html = await render(Single({ ...base, content: post('Hi'), meta }));
    expect(html).toContain('<title>Better &lt;title&gt; | My Site</title>');
    expect(html).not.toContain('<title>Hi |');
    expect(html).toContain('name="robots" content="noindex, follow"');
    const scripts = html.match(/<script type="application\/ld\+json">.*?<\/script>/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('\\u003c/script\\u003e');
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('draws no robots tag or JSON-LD by default', async () => {
    const html = await render(Single({ ...base, content: post('Hi') }));
    expect(html).not.toContain('name="robots"');
    expect(html).not.toContain('ld+json');
  });

  it('jsonLdScript escapes characters that could break out of a script', () => {
    const out = jsonLdScript({ a: '<>&\u2028' });
    expect(out).not.toMatch(/[<>&\u2028]/);
    expect(JSON.parse(out)).toEqual({ a: '<>&\u2028' });
  });
});
