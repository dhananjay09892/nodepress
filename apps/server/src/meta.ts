import type { Content, HookRegistry, MetaTags } from '@nodepress/core';

/** Longest description we put in a tag; search engines cut it near this anyway. */
export const MAX_DESCRIPTION_LENGTH = 300;

export interface BuildMetaInput {
  /** `https://example.com`: the public address, no trailing slash. */
  base: string;
  path: string;
  status: 200 | 404;
  siteName: string;
  tagline: string;
  /** The item being shown; unset on the front page and the 404 page. */
  content?: Content | undefined;
  /** Path or URL of the item's featured image, when it has one. */
  image?: string | undefined;
  /** Whether the site serves `/feed.xml`. */
  hasFeed: boolean;
}

/** Collapse whitespace and cut to `max` characters (at a space when there is one near the end). */
export function toDescription(text: string, max = MAX_DESCRIPTION_LENGTH): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** An absolute `http(s)` URL for a path or URL, or `undefined` when it is neither. */
export function absoluteUrl(base: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('/') && !value.startsWith('//')) return `${base}${value}`;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The SEO tags of a page: description, canonical URL, Open Graph and the feed link. */
export function buildMeta(input: BuildMetaInput): MetaTags {
  const { base, status, siteName, content } = input;
  const excerpt = content?.excerpt ? toDescription(content.excerpt) : '';
  const description = excerpt || toDescription(input.tagline) || siteName;
  const url = status === 404 ? undefined : `${base}${input.path === '/' ? '/' : input.path}`;
  const title = content ? content.title : status === 404 ? 'Page not found' : siteName;
  const image = absoluteUrl(base, input.image);
  return {
    description,
    ...(url ? { canonical: url } : {}),
    ...(input.hasFeed ? { feedUrl: `${base}/feed.xml` } : {}),
    og: {
      title,
      description,
      type: content?.type === 'post' ? 'article' : 'website',
      ...(url ? { url } : {}),
      siteName,
      ...(image ? { image } : {}),
    },
  };
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** Whether a filter returned something a theme can safely draw. */
export function isMetaTags(value: unknown): value is MetaTags {
  if (typeof value !== 'object' || value === null) return false;
  const meta = value as Record<string, unknown>;
  const og = meta.og as Record<string, unknown> | null | undefined;
  return (
    typeof meta.description === 'string' &&
    isOptionalString(meta.canonical) &&
    isOptionalString(meta.feedUrl) &&
    typeof og === 'object' &&
    og !== null &&
    typeof og.title === 'string' &&
    typeof og.description === 'string' &&
    (og.type === 'article' || og.type === 'website') &&
    typeof og.siteName === 'string' &&
    isOptionalString(og.url) &&
    isOptionalString(og.image)
  );
}

/**
 * Run the `meta:tags` filter. A plugin that returns something invalid, or throws, leaves the
 * tags as built (hooks already isolate listener errors; this guards the shape).
 */
export async function filterMeta(
  hooks: HookRegistry,
  meta: MetaTags,
  context: { path: string; status: 200 | 404; content?: Content | undefined },
): Promise<MetaTags> {
  const result: unknown = await hooks.applyFilters('meta:tags', meta, {
    path: context.path,
    status: context.status,
    ...(context.content ? { content: context.content } : {}),
  });
  return isMetaTags(result) ? result : meta;
}
