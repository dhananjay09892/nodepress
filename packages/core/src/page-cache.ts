import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HookRegistry } from './hooks.js';
import { silentLogger, type Logger } from './logger.js';

/** A rendered page as kept in the cache. */
export interface CachedPage {
  status: number;
  /** Only the headers worth replaying (for example `content-type`). */
  headers: Record<string, string>;
  body: string;
  /** Milliseconds since the epoch when it was stored. */
  storedAt: number;
}

/** Where cached pages live. Adapters never throw for a missing or damaged entry: they return `undefined`. */
export interface PageCacheAdapter {
  get(key: string): Promise<CachedPage | undefined>;
  set(key: string, page: CachedPage): Promise<void>;
  /** Forget every page. */
  clear(): Promise<void>;
}

export const DEFAULT_PAGE_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_PAGE_CACHE_ENTRIES = 500;

export interface MemoryPageCacheOptions {
  /** Oldest entries are dropped beyond this many (default 500). */
  maxEntries?: number;
  /** Pages older than this are not served (default 10 minutes). */
  ttlMs?: number;
  now?: () => number;
}

/** Keeps pages in this process, dropping the least recently used when full. */
export function createMemoryPageCache(options: MemoryPageCacheOptions = {}): PageCacheAdapter {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_PAGE_CACHE_ENTRIES);
  const ttlMs = options.ttlMs ?? DEFAULT_PAGE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, CachedPage>();
  return {
    async get(key) {
      const page = entries.get(key);
      if (!page) return undefined;
      if (now() - page.storedAt > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      // Re-insert so the most recently used page is the last one to go.
      entries.delete(key);
      entries.set(key, page);
      return page;
    },
    async set(key, page) {
      entries.delete(key);
      entries.set(key, page);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    async clear() {
      entries.clear();
    },
  };
}

export interface DiskPageCacheOptions {
  /** Folder for the cache files; created when needed. Only `.json` files in it are ever touched. */
  dir: string;
  ttlMs?: number;
  now?: () => number;
}

function isCachedPage(value: unknown): value is CachedPage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['status'] === 'number' &&
    typeof v['body'] === 'string' &&
    typeof v['storedAt'] === 'number' &&
    typeof v['headers'] === 'object' &&
    v['headers'] !== null
  );
}

/**
 * Keeps pages as files (one JSON file per page, named by a hash of its key, so a key can never
 * name a path). It survives restarts and is shared by processes using the same folder.
 */
export function createDiskPageCache(options: DiskPageCacheOptions): PageCacheAdapter {
  const { dir } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_PAGE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const fileFor = (key: string) =>
    join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  return {
    async get(key) {
      try {
        const parsed: unknown = JSON.parse(await readFile(fileFor(key), 'utf8'));
        if (!isCachedPage(parsed) || now() - parsed.storedAt > ttlMs) return undefined;
        return parsed;
      } catch {
        return undefined;
      }
    },
    async set(key, page) {
      await mkdir(dir, { recursive: true });
      const target = fileFor(key);
      // Write then rename, so a reader never sees half a file.
      const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(temp, JSON.stringify(page), 'utf8');
      await rename(temp, target);
    },
    async clear() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      await Promise.all(
        names
          .filter((name) => name.endsWith('.json') || name.endsWith('.tmp'))
          .map((name) => rm(join(dir, name), { force: true })),
      );
    },
  };
}

export interface PageCacheOptions {
  adapter: PageCacheAdapter;
  hooks: HookRegistry;
  logger?: Logger;
}

/** What changes the site's public pages: content changes and any option (menus, widgets, settings). */
const PURGE_ACTIONS = [
  'post:saved',
  'post:published',
  'post:trashed',
  'post:deleted',
  'option:updated',
  'option:deleted',
] as const;

/**
 * The full-page cache for anonymous visitors. `attach()` empties it whenever content is saved,
 * published, trashed or deleted and whenever an option changes (site title, menus, widgets and
 * theme settings are options), so visitors never see a page older than the last change. A cache
 * that fails to read or write is logged and the page is simply rendered, never an error.
 */
export class PageCache {
  readonly #adapter: PageCacheAdapter;
  readonly #hooks: HookRegistry;
  readonly #logger: Logger;
  readonly #source = 'page-cache';
  hits = 0;
  misses = 0;
  /**
   * Counts purges. A page rendered before a purge must not be stored after it, so callers note
   * this before rendering and store only if it is unchanged.
   */
  generation = 0;

  constructor(options: PageCacheOptions) {
    this.#adapter = options.adapter;
    this.#hooks = options.hooks;
    this.#logger = options.logger ?? silentLogger;
  }

  /** Start purging on content and option changes. Safe to call once. */
  attach(): void {
    for (const name of PURGE_ACTIONS) {
      this.#hooks.addAction(name, () => this.purge(), { source: this.#source });
    }
  }

  detach(): void {
    this.#hooks.removeAllFromSource(this.#source);
  }

  async get(key: string): Promise<CachedPage | undefined> {
    try {
      const page = await this.#adapter.get(key);
      if (page) this.hits++;
      else this.misses++;
      return page;
    } catch (error) {
      this.#logger.warn(`Page cache read failed: ${String(error)}`);
      this.misses++;
      return undefined;
    }
  }

  async set(key: string, page: CachedPage): Promise<void> {
    try {
      await this.#adapter.set(key, page);
    } catch (error) {
      this.#logger.warn(`Page cache write failed: ${String(error)}`);
    }
  }

  /** Forget every cached page. */
  async purge(): Promise<void> {
    this.generation++;
    try {
      await this.#adapter.clear();
    } catch (error) {
      this.#logger.warn(`Page cache purge failed: ${String(error)}`);
    }
  }
}

export function createPageCache(options: PageCacheOptions): PageCache {
  return new PageCache(options);
}
