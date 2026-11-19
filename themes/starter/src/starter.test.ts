import type { TemplateProps } from '@nodepress/core';
import { describe, expect, it } from 'vitest';
import Index from './index.js';
import NotFound from './404.js';
import Single from './single.js';

const theme = { name: 'starter', version: '0.1.0', assetsUrl: '/themes/starter/assets' };
const base: TemplateProps = { siteName: 'My <Site>', path: '/blog/hi', status: 200, theme };

async function render(node: unknown): Promise<string> {
  return String(await (node as { toString(): string | Promise<string> }).toString());
}

describe('starter theme templates', () => {
  it('draws a post with the layout, escaping text but keeping trusted body HTML', async () => {
    const html = await render(
      Single({
        ...base,
        content: { title: 'Hello <b>', excerpt: 'A & B' } as TemplateProps['content'],
        html: '<p>Body</p>',
      }),
    );
    expect(html).toContain('<h1>Hello &lt;b&gt;</h1>');
    expect(html).toContain('<p>A &amp; B</p>');
    expect(html).toContain('<p>Body</p>');
    expect(html).toContain('<title>Hello &lt;b&gt; | My &lt;Site&gt;</title>');
    expect(html).toContain('href="/themes/starter/assets/style.css"');
  });

  it('draws the 404 page and shows the path as text', async () => {
    const html = await render(NotFound({ ...base, status: 404, path: '/<script>' }));
    expect(html).toContain('Page not found');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('index falls back to the 404 or single template by status', async () => {
    expect(await render(Index({ ...base, status: 404 }))).toContain('Page not found');
    expect(await render(Index({ ...base, content: { title: 'T' } as TemplateProps['content'] }))).toContain(
      '<h1>T</h1>',
    );
  });
});
