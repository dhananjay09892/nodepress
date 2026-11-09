import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createContentStore, createDatabase, createSlugRedirectsStore } from './index.js';
import type { DatabaseHandle } from './index.js';

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const base = {
  type: 'post',
  status: 'published',
  title: 'T',
  body: [],
  excerpt: null,
  authorId: null,
  parentId: null,
  publishedAt: null,
};

async function exercise(h: DatabaseHandle): Promise<void> {
  const content = createContentStore(h);
  const store = createSlugRedirectsStore(h);
  const a = await content.insert({ ...base, slug: 'new-a' });
  const b = await content.insert({ ...base, slug: 'new-b' });

  expect(await store.find('post', 'old-a')).toBeUndefined();

  const saved = await store.upsert({ contentId: a.id, type: 'post', slug: 'old-a' });
  expect(saved).toMatchObject({ contentId: a.id, type: 'post', slug: 'old-a' });
  expect(await store.find('post', 'old-a')).toMatchObject({ contentId: a.id });
  // Slugs are scoped by content type.
  expect(await store.find('page', 'old-a')).toBeUndefined();

  // The same old slug re-recorded for other content points at the newest owner.
  await store.upsert({ contentId: b.id, type: 'post', slug: 'old-a' });
  expect(await store.find('post', 'old-a')).toMatchObject({ id: saved.id, contentId: b.id });

  expect(await store.delete('post', 'old-a')).toBe(true);
  expect(await store.delete('post', 'old-a')).toBe(false);
  expect(await store.find('post', 'old-a')).toBeUndefined();

  // Deleting the content deletes its remembered slugs.
  await store.upsert({ contentId: a.id, type: 'post', slug: 'older-a' });
  await content.delete(a.id);
  expect(await store.find('post', 'older-a')).toBeUndefined();
}

describe('slug redirects store', () => {
  it('works on SQLite', async () => {
    handle = createDatabase({ url: ':memory:' });
    await handle.migrate();
    await exercise(handle);
  });

  it.skipIf(!POSTGRES_URL)('works on PostgreSQL', async () => {
    const h = createDatabase({ url: POSTGRES_URL! });
    handle = h;
    if (h.dialect !== 'postgres') throw new Error('expected postgres');
    await h.db.execute(sql`drop schema if exists drizzle cascade`);
    await h.db.execute(sql`drop schema public cascade`);
    await h.db.execute(sql`create schema public`);
    await h.migrate();
    await exercise(h);
  });
});
