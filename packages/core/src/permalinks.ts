import type { Content, ContentStore } from './content.js';
import type { HookRegistry } from './hooks.js';
import { silentLogger, type Logger } from './logger.js';
import type { OptionsService } from './options.js';

/** Option holding the permalink pattern of `post` content. */
export const PERMALINK_OPTION = 'permalink_structure';
export const DEFAULT_POST_PATTERN = '/blog/:slug';
export const MAX_PATTERN_LENGTH = 200;

declare module './options.js' {
  interface OptionMap {
    /** Permalink pattern for posts, e.g. `/blog/:slug` or `/:year/:month/:slug`. */
    permalink_structure: string;
  }
}

declare module './hooks.js' {
  interface FilterMap {
    /**
     * The permalink pattern used for a content type. Plugins can give custom types their own
     * pattern. An invalid result is ignored and the built-in pattern is used.
     */
    'permalink:pattern': { value: string; context: { type: string } };
  }
}

/** Storage for old slugs. `@nodepress/db` provides `createSlugRedirectsStore()`. */
export interface SlugRedirectStore {
  /** Remember an old slug; if (type, slug) is already remembered it now points at `contentId`. */
  upsert(row: { contentId: number; type: string; slug: string }): Promise<unknown>;
  find(type: string, slug: string): Promise<{ contentId: number } | undefined>;
  /** Forget an old slug. Returns true if one was removed. */
  delete(type: string, slug: string): Promise<boolean>;
}

export class PermalinkPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermalinkPatternError';
  }
}

const TOKENS = ['slug', 'id', 'year', 'month', 'day'] as const;
type Token = (typeof TOKENS)[number];

const TOKEN_REGEX: Record<Token, string> = {
  slug: '[a-z0-9]+(?:-[a-z0-9]+)*',
  id: '[1-9][0-9]*',
  year: '[0-9]{4}',
  month: '[0-9]{2}',
  day: '[0-9]{2}',
};

type Segment = { literal: string } | { token: Token };

function isToken(name: string): name is Token {
  return (TOKENS as readonly string[]).includes(name);
}

/** A parsed, validated permalink pattern. */
export interface ParsedPattern {
  readonly pattern: string;
  readonly segments: readonly (readonly Segment[])[];
}

/**
 * Parse a pattern such as `/blog/:year/:slug`. Rules: starts with `/`, no trailing slash, no
 * empty segments, literals use `a-z 0-9 _ -`, only the known tokens, and exactly one of `:slug`
 * or `:id` so every URL identifies one item.
 */
export function parsePattern(pattern: string): ParsedPattern {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new PermalinkPatternError('Permalink pattern must be a non-empty string');
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new PermalinkPatternError(`Permalink pattern is longer than ${MAX_PATTERN_LENGTH}`);
  }
  if (!pattern.startsWith('/')) throw new PermalinkPatternError('Permalink pattern must start "/"');
  if (pattern.length > 1 && pattern.endsWith('/')) {
    throw new PermalinkPatternError('Permalink pattern must not end with "/"');
  }
  const segments: Segment[][] = [];
  const seen = new Set<Token>();
  for (const raw of pattern.slice(1).split('/')) {
    if (raw === '') throw new PermalinkPatternError('Permalink pattern has an empty segment');
    const parts: Segment[] = [];
    for (const piece of raw.split(/(:[a-z]+)/).filter((p) => p !== '')) {
      if (piece.startsWith(':')) {
        const name = piece.slice(1);
        if (!isToken(name)) throw new PermalinkPatternError(`Unknown permalink token ":${name}"`);
        if (seen.has(name)) throw new PermalinkPatternError(`Token ":${name}" is used twice`);
        seen.add(name);
        parts.push({ token: name });
      } else {
        if (!/^[a-z0-9_-]+$/.test(piece)) {
          throw new PermalinkPatternError(`Invalid characters in "${piece}"`);
        }
        parts.push({ literal: piece });
      }
    }
    segments.push(parts);
  }
  if (seen.has('slug') === seen.has('id')) {
    throw new PermalinkPatternError('Permalink pattern needs exactly one of ":slug" or ":id"');
  }
  return { pattern, segments };
}

function tryParse(pattern: unknown): ParsedPattern | undefined {
  if (typeof pattern !== 'string') return undefined;
  try {
    return parsePattern(pattern);
  } catch {
    return undefined;
  }
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/** Values for the tokens of a content item (dates are UTC). */
function tokenValues(content: Content): Record<Token, string> {
  const date = content.publishedAt ?? content.createdAt;
  return {
    slug: content.slug,
    id: String(content.id),
    year: pad(date.getUTCFullYear(), 4),
    month: pad(date.getUTCMonth() + 1, 2),
    day: pad(date.getUTCDate(), 2),
  };
}

/** The path of `content` under a parsed pattern. */
export function buildPath(parsed: ParsedPattern, content: Content): string {
  const values = tokenValues(content);
  return (
    '/' +
    parsed.segments
      .map((parts) => parts.map((p) => ('literal' in p ? p.literal : values[p.token])).join(''))
      .join('/')
  );
}

/** Token values captured from a path, or undefined if the path does not fit the pattern. */
function matchPath(parsed: ParsedPattern, path: string): Partial<Record<Token, string>> | undefined {
  const pieces = path.slice(1).split('/');
  if (pieces.length !== parsed.segments.length) return undefined;
  const captured: Partial<Record<Token, string>> = {};
  for (let i = 0; i < pieces.length; i++) {
    const source = parsed.segments[i]!
      .map((p) =>
        'literal' in p ? p.literal.replace(/[-_]/g, '\\$&') : `(?<${p.token}>${TOKEN_REGEX[p.token]})`,
      )
      .join('');
    const m = new RegExp(`^${source}$`).exec(pieces[i]!);
    if (!m) return undefined;
    Object.assign(captured, m.groups);
  }
  return captured;
}

export type ResolvedRoute =
  | { kind: 'content'; status: 200; content: Content; path: string }
  | { kind: 'redirect'; status: 301; to: string }
  | { kind: 'not_found'; status: 404 };

const NOT_FOUND: ResolvedRoute = { kind: 'not_found', status: 404 };

export interface PermalinkServiceOptions {
  store: ContentStore;
  redirects: SlugRedirectStore;
  options: OptionsService;
  hooks: HookRegistry;
  logger?: Logger;
  /** Content types to resolve, in priority order. Defaults to `page`, then `post`. */
  contentTypes?: () => string[];
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/**
 * Turns content into URLs and URLs back into content.
 *
 * - `post` content uses the pattern in the `permalink_structure` option; `page` lives at
 *   `/:slug`; other types at `/:type/:slug`. The `permalink:pattern` filter can override a type.
 * - Only published content whose publish date has passed is public.
 * - `attach()` remembers a slug when it changes, so the old URL redirects (301) to the new one.
 * - A URL with a trailing slash, or the wrong date parts, redirects to the canonical URL.
 */
export class PermalinkService {
  readonly #store: ContentStore;
  readonly #redirects: SlugRedirectStore;
  readonly #options: OptionsService;
  readonly #hooks: HookRegistry;
  readonly #logger: Logger;
  readonly #contentTypes: () => string[];
  readonly #now: () => Date;

  constructor(opts: PermalinkServiceOptions) {
    this.#store = opts.store;
    this.#redirects = opts.redirects;
    this.#options = opts.options;
    this.#hooks = opts.hooks;
    this.#logger = opts.logger ?? silentLogger;
    this.#contentTypes = opts.contentTypes ?? (() => ['page', 'post']);
    this.#now = opts.now ?? (() => new Date());
  }

  /** The configured pattern for posts (the default if unset or invalid). */
  async getStructure(): Promise<string> {
    const stored = await this.#options.get(PERMALINK_OPTION);
    return tryParse(stored)?.pattern ?? DEFAULT_POST_PATTERN;
  }

  /** Validate and save the post pattern. Throws `PermalinkPatternError` if it is invalid. */
  async setStructure(pattern: string): Promise<void> {
    parsePattern(pattern);
    await this.#options.set(PERMALINK_OPTION, pattern);
  }

  /** The parsed pattern for a content type, after the `permalink:pattern` filter. */
  async patternFor(type: string): Promise<ParsedPattern> {
    const builtIn =
      type === 'post' ? await this.getStructure() : type === 'page' ? '/:slug' : `/${type}/:slug`;
    const filtered = await this.#hooks.applyFilters('permalink:pattern', builtIn, { type });
    return tryParse(filtered) ?? parsePattern(tryParse(builtIn) ? builtIn : '/:slug');
  }

  /** The canonical path of a content item. */
  async pathFor(content: Content): Promise<string> {
    return buildPath(await this.patternFor(content.type), content);
  }

  /**
   * Remember old slugs: when a `post:saved` update changes the slug, the old one starts
   * redirecting. Returns an unsubscribe function. Failures are logged, never thrown.
   */
  attach(): () => void {
    return this.#hooks.addAction('post:saved', async (content, info) => {
      try {
        const changed = info.previous !== undefined && info.previous.slug !== content.slug;
        if (changed) {
          await this.#redirects.upsert({
            contentId: content.id,
            type: content.type,
            slug: info.previous!.slug,
          });
        }
        // A slug that is live again (or taken by new content) no longer needs a redirect.
        if (changed || info.isNew) await this.#redirects.delete(content.type, content.slug);
      } catch (error) {
        this.#logger.warn(
          `Could not record slug redirect for content ${content.id}: ${String(error)}`,
        );
      }
    });
  }

  /** Resolve a request path (no query string) to content, a redirect or a 404. */
  async resolve(rawPath: string): Promise<ResolvedRoute> {
    const path = normalizePath(rawPath);
    if (path === undefined) return NOT_FOUND;
    const trailingSlash = path !== '/' && path.endsWith('/');
    const clean = trailingSlash ? path.slice(0, -1) : path;
    if (clean === '/') return NOT_FOUND; // the front page is not content

    for (const type of this.#contentTypes()) {
      const parsed = await this.patternFor(type);
      const captured = matchPath(parsed, clean);
      if (!captured) continue;

      let content: Content | undefined;
      let viaRedirect = false;
      if (captured.id !== undefined) {
        const found = await this.#store.findById(Number(captured.id));
        content = found?.type === type ? found : undefined;
      } else if (captured.slug !== undefined) {
        content = await this.#store.findBySlug(type, captured.slug);
        if (!this.#isPublic(content)) {
          const old = await this.#redirects.find(type, captured.slug);
          const target = old ? await this.#store.findById(old.contentId) : undefined;
          if (target?.type === type) {
            content = target;
            viaRedirect = true;
          }
        }
      }
      if (!content || !this.#isPublic(content)) continue;

      const canonical = buildPath(parsed, content);
      if (viaRedirect || trailingSlash || canonical !== clean) {
        return { kind: 'redirect', status: 301, to: canonical };
      }
      return { kind: 'content', status: 200, content, path: canonical };
    }
    return NOT_FOUND;
  }

  #isPublic(content: Content | undefined): content is Content {
    return (
      content !== undefined &&
      content.status === 'published' &&
      (content.publishedAt === null || content.publishedAt.getTime() <= this.#now().getTime())
    );
  }
}

/** Decode a URL path; undefined for anything that can't be a content URL. */
function normalizePath(raw: string): string | undefined {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > 2048) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (decoded.includes('//') || decoded.includes('\\') || decoded.includes('\0')) return undefined;
  if (decoded.split('/').some((s) => s === '.' || s === '..')) return undefined;
  return decoded;
}

export function createPermalinkService(options: PermalinkServiceOptions): PermalinkService {
  return new PermalinkService(options);
}
