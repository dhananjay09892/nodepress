import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createContentMetaStore,
  createContentStore,
  createDatabase,
  type DatabaseHandle,
} from './index.js';

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const base = {
  type: 'post',
  status: 'draft',
  title: 'T',
  body: [],
  excerpt: null,
  authorId: null,
  parentId: null,
  publishedAt: null,
};

/** The same behaviour on every dialect: JSON values round-trip, upsert replaces, delete removes. */
async function exercise(h: DatabaseHandle): Promise<void> {
  const content = createContentStore(h);
  const store = createContentMetaStore(h);
  const a = await content.insert({ ...base, slug: 'a' });
  const b = await content.insert({ ...base, slug: 'b' });

  expect(await store.getMeta(a.id)).toEqual({});
  expect((await store.getMetaMany([])).size).toBe(0);

  const values = {
    text: 'plain',
    looksLikeJson: '{"a":1}',
    looksLikeNumber: '7',
    number: 7,
    zero: 0,
    no: false,
    list: [1, 'two', { three: 3 }],
    object: { nested: { ok: true } },
  };
  await store.setMeta(a.id, values);
  expect(await store.getMeta(a.id)).toEqual(values);

  // Upsert replaces one key and leaves the others; undefined is skipped.
  await store.setMeta(a.id, { text: 'changed', skipped: undefined });
  expect(await store.getMeta(a.id)).toEqual({ ...values, text: 'changed' });

  await store.setMeta(b.id, { text: 'other' });
  const many = await store.getMetaMany([a.id, b.id, 999]);
  expect(many.get(b.id)).toEqual({ text: 'other' });
  expect(many.get(a.id)).toEqual({ ...values, text: 'changed' });
  expect(many.has(999)).toBe(false);

  await store.deleteMeta(a.id, ['text', 'number', 'missing']);
  await store.deleteMeta(a.id, []);
  const left: Record<string, unknown> = { ...values };
  delete left.text;
  delete left.number;
  expect(await store.getMeta(a.id)).toEqual(left);
  expect(await store.getMeta(b.id)).toEqual({ text: 'other' });

  // Values go with their item.
  await content.delete(b.id);
  expect(await store.getMeta(b.id)).toEqual({});
}

describe('content meta store', () => {
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
