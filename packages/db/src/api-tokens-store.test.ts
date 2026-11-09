import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApiTokensStore,
  createDatabase,
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
  const store = createApiTokensStore(h);
  const future = new Date(Date.now() + 60_000);

  expect(await store.findByHash('nope')).toBeUndefined();
  const t1 = await store.insert({ userId: u1.id, name: 'one', tokenHash: 'h1', expiresAt: null });
  expect(t1).toMatchObject({ userId: u1.id, name: 'one', tokenHash: 'h1', lastUsedAt: null });
  expect(t1.expiresAt).toBeNull();
  expect(t1.createdAt).toBeInstanceOf(Date);
  const t2 = await store.insert({ userId: u1.id, name: 'two', tokenHash: 'h2', expiresAt: future });
  expect(t2.expiresAt?.getTime()).toBe(future.getTime());
  await store.insert({ userId: u2.id, name: 'three', tokenHash: 'h3', expiresAt: null });

  // token_hash is unique.
  await expect(
    store.insert({ userId: u2.id, name: 'dup', tokenHash: 'h1', expiresAt: null }),
  ).rejects.toThrow();

  expect((await store.findByHash('h2'))?.id).toBe(t2.id);
  expect((await store.listByUser(u1.id)).map((t) => t.name)).toEqual(['one', 'two']);
  expect(await store.countByUser(u1.id)).toBe(2);
  expect(await store.countByUser(u2.id)).toBe(1);

  const at = new Date(Date.now() - 5_000);
  await store.touch(t1.id, at);
  expect((await store.findByHash('h1'))?.lastUsedAt?.getTime()).toBe(at.getTime());

  // Deleting is scoped to the owner.
  expect(await store.delete(t1.id, u2.id)).toBe(false);
  expect(await store.delete(t1.id, u1.id)).toBe(true);
  expect(await store.delete(t1.id, u1.id)).toBe(false);
  expect(await store.deleteByUser(u1.id)).toBe(1);
  expect(await store.deleteByUser(u1.id)).toBe(0);

  // Tokens go away with their user.
  await users.delete(u2.id);
  expect(await store.countByUser(u2.id)).toBe(0);
}

describe('api tokens store', () => {
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
