import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createSessionsStore,
  createUsersStore,
  type DatabaseHandle,
} from './index.js';

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function exercise(h: DatabaseHandle): Promise<void> {
  const users = createUsersStore(h);
  const u1 = await users.insert({
    email: 'a@example.com',
    passwordHash: 'x',
    displayName: 'A',
    role: 'author',
  });
  const u2 = await users.insert({
    email: 'b@example.com',
    passwordHash: 'x',
    displayName: 'B',
    role: 'author',
  });
  const store = createSessionsStore(h);
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);

  expect(await store.findById('nope')).toBeUndefined();
  const created = await store.insert({ id: 's1', userId: u1.id, expiresAt: future });
  expect(created).toMatchObject({ id: 's1', userId: u1.id });
  expect(created.createdAt).toBeInstanceOf(Date);
  expect((await store.findById('s1'))?.expiresAt.getTime()).toBe(future.getTime());

  // The primary key rejects a duplicate id.
  await expect(store.insert({ id: 's1', userId: u1.id, expiresAt: future })).rejects.toThrow();

  await store.insert({ id: 's2', userId: u1.id, expiresAt: past });
  await store.insert({ id: 's3', userId: u2.id, expiresAt: future });

  expect(await store.deleteExpired(new Date())).toBe(1);
  expect(await store.findById('s2')).toBeUndefined();

  expect(await store.delete('s1')).toBe(true);
  expect(await store.delete('s1')).toBe(false);

  await store.insert({ id: 's4', userId: u2.id, expiresAt: future });
  expect(await store.deleteByUser(u2.id)).toBe(2);
  expect(await store.deleteByUser(u2.id)).toBe(0);
}

describe('sessions store', () => {
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
