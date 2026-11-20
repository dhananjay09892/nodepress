import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import type { Logger } from './logger.js';
import {
  createDiskPageCache,
  createMemoryPageCache,
  createPageCache,
  type CachedPage,
  type PageCacheAdapter,
} from './page-cache.js';

const page = (body: string, storedAt = Date.now()): CachedPage => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=UTF-8' },
  body,
  storedAt,
});

describe('memory adapter', () => {
  it('returns what was stored, and nothing for an unknown key', async () => {
    const cache = createMemoryPageCache();
    await cache.set('/a', page('A'));
    expect((await cache.get('/a'))?.body).toBe('A');
    expect(await cache.get('/b')).toBeUndefined();
  });

  it('does not serve a page older than the time to live', async () => {
    let now = 1000;
    const cache = createMemoryPageCache({ ttlMs: 500, now: () => now });
    await cache.set('/a', page('A', now));
    now = 1400;
    expect(await cache.get('/a')).toBeDefined();
    now = 1501;
    expect(await cache.get('/a')).toBeUndefined();
  });

  it('drops the least recently used page when full', async () => {
    const cache = createMemoryPageCache({ maxEntries: 2, now: () => 0 });
    await cache.set('/a', page('A', 0));
    await cache.set('/b', page('B', 0));
    await cache.get('/a'); // /a is now more recent than /b
    await cache.set('/c', page('C', 0));
    expect(await cache.get('/b')).toBeUndefined();
    expect(await cache.get('/a')).toBeDefined();
    expect(await cache.get('/c')).toBeDefined();
  });

  it('clear forgets everything', async () => {
    const cache = createMemoryPageCache();
    await cache.set('/a', page('A'));
    await cache.clear();
    expect(await cache.get('/a')).toBeUndefined();
  });
});

describe('disk adapter', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  const make = async (options: { ttlMs?: number; now?: () => number } = {}) => {
    dir = await mkdtemp(join(tmpdir(), 'np-page-cache-'));
    return createDiskPageCache({ dir: join(dir, 'cache'), ...options });
  };

  it('stores pages as files and reads them back, creating the folder', async () => {
    const cache = await make();
    await cache.set('/hello?x=1', page('Hi'));
    expect((await cache.get('/hello?x=1'))?.body).toBe('Hi');
    expect(await cache.get('/other')).toBeUndefined();
    const files = await readdir(join(dir, 'cache'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it('cannot be steered out of its folder by a key', async () => {
    const cache = await make();
    await cache.set('../../escape', page('x'));
    expect(await readdir(join(dir, 'cache'))).toHaveLength(1);
    expect(await readdir(dir)).toEqual(['cache']);
  });

  it('honours the time to live and ignores damaged files', async () => {
    let now = 0;
    const cache = await make({ ttlMs: 100, now: () => now });
    await cache.set('/a', page('A', 0));
    now = 101;
    expect(await cache.get('/a')).toBeUndefined();
    await cache.set('/b', page('B', 101));
    for (const file of await readdir(join(dir, 'cache'))) {
      await writeFile(join(dir, 'cache', file), '{not json');
    }
    expect(await cache.get('/a')).toBeUndefined();
    expect(await cache.get('/b')).toBeUndefined();
  });

  it('clear removes cache files only', async () => {
    const cache = await make();
    await cache.set('/a', page('A'));
    await cache.set('/b', page('B'));
    await writeFile(join(dir, 'cache', 'notes.txt'), 'keep me');
    await cache.clear();
    expect(await readdir(join(dir, 'cache'))).toEqual(['notes.txt']);
    await expect(
      createDiskPageCache({ dir: join(dir, 'missing') }).clear(),
    ).resolves.toBeUndefined();
  });
});

describe('PageCache', () => {
  const quiet = (warnings: string[] = []): Logger => {
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (m) => void warnings.push(m),
      error() {},
      child: () => logger,
    };
    return logger;
  };

  it('counts hits and misses', async () => {
    const cache = createPageCache({ adapter: createMemoryPageCache(), hooks: new HookRegistry() });
    expect(await cache.get('/a')).toBeUndefined();
    await cache.set('/a', page('A'));
    expect(await cache.get('/a')).toBeDefined();
    expect([cache.hits, cache.misses]).toEqual([1, 1]);
  });

  it.each([
    ['post:saved', [{ id: 1 }, { isNew: true }]],
    ['post:published', [{ id: 1 }]],
    ['post:trashed', [{ id: 1 }]],
    ['post:deleted', [{ id: 1 }]],
    ['option:updated', ['site_title', 'New', 'Old']],
    ['option:deleted', ['site_title', 'Old']],
  ] as const)('is emptied when %s fires', async (action, args) => {
    const hooks = new HookRegistry();
    const cache = createPageCache({ adapter: createMemoryPageCache(), hooks });
    cache.attach();
    await cache.set('/a', page('A'));
    await hooks.doAction(action, ...(args as unknown as never[]));
    expect(await cache.get('/a')).toBeUndefined();
  });

  it('keeps pages for unrelated actions and stops purging after detach', async () => {
    const hooks = new HookRegistry();
    const cache = createPageCache({ adapter: createMemoryPageCache(), hooks });
    cache.attach();
    await cache.set('/a', page('A'));
    await hooks.doAction('some:other', 1);
    expect(await cache.get('/a')).toBeDefined();
    cache.detach();
    await hooks.doAction('post:saved', { id: 1 } as never, { isNew: false });
    expect(await cache.get('/a')).toBeDefined();
  });

  it('counts purges so a page rendered before one can be told apart', async () => {
    const cache = createPageCache({ adapter: createMemoryPageCache(), hooks: new HookRegistry() });
    const before = cache.generation;
    await cache.purge();
    expect(cache.generation).toBe(before + 1);
  });

  it('logs and carries on when the adapter fails', async () => {
    const warnings: string[] = [];
    const broken: PageCacheAdapter = {
      get: async () => {
        throw new Error('disk gone');
      },
      set: async () => {
        throw new Error('disk gone');
      },
      clear: async () => {
        throw new Error('disk gone');
      },
    };
    const cache = createPageCache({
      adapter: broken,
      hooks: new HookRegistry(),
      logger: quiet(warnings),
    });
    expect(await cache.get('/a')).toBeUndefined();
    await expect(cache.set('/a', page('A'))).resolves.toBeUndefined();
    await expect(cache.purge()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(3);
  });
});
