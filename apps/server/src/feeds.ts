import type { Content, ContentService, PermalinkService } from '@nodepress/core';
import { Hono } from 'hono';

export const SITEMAP_PAGE_SIZE = 100;
/** A sitemap file may list at most 50,000 URLs; this keeps it far below that. */
export const SITEMAP_MAX_URLS = 5000;
export const FEED_ITEMS = 20;

export interface FeedRoutesOptions {
  content: Pick<ContentService, 'list'>;
  permalinks: Pick<PermalinkService, 'pathFor'>;
  siteName: () => string;
  tagline?: () => string | Promise<string>;
  /** The public address of the site (for example `https://example.com`). Without it the request's own origin is used. */
  siteUrl?: string | undefined;
}

/** Escape text for XML (elements and attributes). Control characters XML cannot hold are removed. */
export function xmlEscape(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}

/** `https://example.com` for a configured address (a trailing slash and any path are dropped); `undefined` if it is not an http(s) URL. */
export function cleanSiteUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

async function allPublished(
  content: Pick<ContentService, 'list'>,
  type: string,
): Promise<Content[]> {
  const out: Content[] = [];
  for (let offset = 0; out.length < SITEMAP_MAX_URLS; offset += SITEMAP_PAGE_SIZE) {
    const batch = await content.list({
      type,
      status: 'published',
      orderBy: 'id',
      direction: 'asc',
      limit: SITEMAP_PAGE_SIZE,
      offset,
    });
    out.push(...batch);
    if (batch.length < SITEMAP_PAGE_SIZE) break;
  }
  return out.slice(0, SITEMAP_MAX_URLS);
}

/** `/sitemap.xml` (the front page, pages and posts) and `/feed.xml` (RSS 2.0, the latest posts). */
export function createFeedRoutes(options: FeedRoutesOptions): Hono {
  const routes = new Hono();
  const configured = cleanSiteUrl(options.siteUrl);
  const origin = (requestUrl: string) => configured ?? new URL(requestUrl).origin;

  routes.get('/sitemap.xml', async (c) => {
    const base = origin(c.req.url);
    const entries: string[] = [`<url><loc>${xmlEscape(`${base}/`)}</loc></url>`];
    for (const type of ['page', 'post']) {
      for (const item of await allPublished(options.content, type)) {
        const loc = `${base}${await options.permalinks.pathFor(item)}`;
        entries.push(
          `<url><loc>${xmlEscape(loc)}</loc><lastmod>${item.updatedAt.toISOString()}</lastmod></url>`,
        );
      }
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>\n`;
    return c.body(xml, 200, { 'content-type': 'application/xml; charset=UTF-8' });
  });

  routes.get('/feed.xml', async (c) => {
    const base = origin(c.req.url);
    const posts = await options.content.list({
      type: 'post',
      status: 'published',
      orderBy: 'publishedAt',
      direction: 'desc',
      limit: FEED_ITEMS,
    });
    const items: string[] = [];
    for (const post of posts) {
      const link = xmlEscape(`${base}${await options.permalinks.pathFor(post)}`);
      const date = (post.publishedAt ?? post.updatedAt).toUTCString();
      items.push(
        `<item><title>${xmlEscape(post.title)}</title><link>${link}</link>` +
          `<guid isPermaLink="true">${link}</guid><pubDate>${date}</pubDate>` +
          `<description>${xmlEscape(post.excerpt ?? '')}</description></item>`,
      );
    }
    const tagline = options.tagline ? await options.tagline() : '';
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>` +
      `<title>${xmlEscape(options.siteName())}</title><link>${xmlEscape(`${base}/`)}</link>` +
      `<description>${xmlEscape(tagline || options.siteName())}</description>` +
      `<atom:link href="${xmlEscape(`${base}/feed.xml`)}" rel="self" type="application/rss+xml"/>` +
      `${items.join('')}</channel></rss>\n`;
    return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=UTF-8' });
  });

  return routes;
}
