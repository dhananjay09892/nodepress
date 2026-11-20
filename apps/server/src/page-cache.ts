import type { PageCache } from '@nodepress/core';
import type { MiddlewareHandler } from 'hono';

/** Content types worth keeping: pages, the sitemap and the feed. */
const CACHEABLE = /^(?:text\/html|application\/xml|application\/rss\+xml)\b/i;
/** Paths that are never cached: the API, the admin app and theme files (which have their own caching). */
const SKIPPED_PREFIXES = ['/api', '/admin', '/themes'];

function skippedPath(path: string): boolean {
  return SKIPPED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Serves anonymous `GET` pages from the cache and stores the ones it renders. A request is only
 * eligible with no query string (previews and tracking links are never cached), no session cookie
 * and no `Authorization` header; only `200` responses that set no cookie are stored. Replies carry
 * `X-NodePress-Cache: hit` or `miss`. A page rendered while a purge happened is not stored.
 */
export function createPageCacheMiddleware(cache: PageCache): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const signedIn = /(?:^|[;\s])(?:__Host-)?np_session=/.test(c.req.header('cookie') ?? '');
    if (
      c.req.method !== 'GET' ||
      url.search !== '' ||
      skippedPath(url.pathname) ||
      signedIn ||
      c.req.header('authorization') !== undefined
    ) {
      return next();
    }

    const key = url.pathname;
    const cached = await cache.get(key);
    if (cached) {
      return new Response(cached.body, {
        status: cached.status,
        headers: { ...cached.headers, 'x-nodepress-cache': 'hit' },
      });
    }

    const generation = cache.generation;
    await next();
    const type = c.res.headers.get('content-type') ?? '';
    if (c.res.status === 200 && CACHEABLE.test(type) && !c.res.headers.has('set-cookie')) {
      const body = await c.res.clone().text();
      if (cache.generation === generation) {
        await cache.set(key, {
          status: 200,
          headers: { 'content-type': type },
          body,
          storedAt: Date.now(),
        });
      }
      c.res.headers.set('x-nodepress-cache', 'miss');
    }
    return undefined;
  };
}
