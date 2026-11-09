import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, createUsersStore, type DatabaseHandle } from './index.js';

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function exercise(h: DatabaseHandle): Promise<void> {
  const store = createUsersStore(h);
  expect(await store.findById(1)).toBeUndefined();
  expect(await store.findByEmail('a@example.com')).toBeUndefined();

  const a = await store.insert({
    email: 'a@example.com',
    passwordHash: 'hash-a',
    displayName: 'A',
    role: 'administrator',
  });
  const b = await store.insert({
    email: 'b@example.com',
    passwordHash: 'hash-b',
    displayName: 'B',
    role: 'author',
  });
  expect(a.id).not.toBe(b.id);
  expect(a.createdAt).toBeInstanceOf(Date);

  expect(await store.findById(a.id)).toMatchObject({ email: 'a@example.com', role: 'administrator' });
  expect(await store.findByEmail('b@example.com')).toMatchObject({ id: b.id });
  expect((await store.list()).map((u) => u.email)).toEqual(['a@example.com', 'b@example.com']);

  // The unique index on email rejects duplicates.
  await expect(
    store.insert({ email: 'a@example.com', passwordHash: 'x', displayName: 'Dup', role: 'author' }),
  ).rejects.toThrow();

  const updated = await store.update(b.id, { displayName: 'Bee', role: 'editor' });
  expect(updated).toMatchObject({ displayName: 'Bee', role: 'editor', passwordHash: 'hash-b' });
  expect(await store.update(9999, { displayName: 'x' })).toBeUndefined();
  expect(await store.update(b.id, {})).toMatchObject({ displayName: 'Bee' });

  expect(await store.countByRole('administrator')).toBe(1);
  expect(await store.countByRole('author')).toBe(0);

  expect(await store.delete(b.id)).toBe(true);
  expect(await store.delete(b.id)).toBe(false);
}

describe('users store', () => {
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
