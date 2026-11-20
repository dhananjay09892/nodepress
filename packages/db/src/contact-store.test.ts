import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createContactSubmissionsStore, createDatabase } from './index.js';
import type { DatabaseHandle } from './index.js';

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const row = (n: number) => ({
  form: 'contact',
  name: `Name ${n}`,
  email: `n${n}@example.com`,
  message: `Message ${n}`,
  ipHash: 'abc',
  mailStatus: 'sent',
});

async function exercise(h: DatabaseHandle): Promise<void> {
  const store = createContactSubmissionsStore(h);
  expect(await store.count()).toBe(0);
  const first = await store.insert(row(1));
  await store.insert(row(2));
  await store.insert(row(3));
  expect(first.id).toBeGreaterThan(0);
  expect(first.createdAt).toBeInstanceOf(Date);
  expect(await store.count()).toBe(3);
  expect((await store.list({ limit: 10, offset: 0 })).map((r) => r.name)).toEqual([
    'Name 3',
    'Name 2',
    'Name 1',
  ]);
  expect((await store.list({ limit: 1, offset: 1 })).map((r) => r.name)).toEqual(['Name 2']);
}

describe('contact submissions store', () => {
  it('stores and lists newest first (SQLite)', async () => {
    handle = createDatabase({ url: ':memory:' });
    await handle.migrate();
    await exercise(handle);
  });

  it.skipIf(!POSTGRES_URL)('stores and lists newest first (PostgreSQL)', async () => {
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
