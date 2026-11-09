import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createMediaStore,
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
  const store = createMediaStore(h);

  expect(await store.findById(1)).toBeUndefined();
  const m1 = await store.insert({
    path: 'uploads/2026/11/a-1.jpg',
    mime: 'image/jpeg',
    size: 1234,
    width: 800,
    height: 600,
    alt: 'first',
    variants: { thumbnail: 'uploads/2026/11/a-1-thumbnail.jpg' },
    uploadedBy: u1.id,
  });
  expect(m1).toMatchObject({
    path: 'uploads/2026/11/a-1.jpg',
    mime: 'image/jpeg',
    size: 1234,
    width: 800,
    height: 600,
    alt: 'first',
    variants: { thumbnail: 'uploads/2026/11/a-1-thumbnail.jpg' },
    uploadedBy: u1.id,
  });
  expect(m1.createdAt).toBeInstanceOf(Date);
  const m2 = await store.insert({
    path: 'uploads/2026/11/b-2.pdf',
    mime: 'application/pdf',
    size: 10,
    width: null,
    height: null,
    alt: '',
    variants: {},
    uploadedBy: u2.id,
  });
  expect(m2).toMatchObject({ width: null, height: null, variants: {} });

  expect((await store.findById(m1.id))?.path).toBe(m1.path);
  expect((await store.list({ limit: 10, offset: 0 })).map((m) => m.id)).toEqual([m2.id, m1.id]);
  expect((await store.list({ limit: 1, offset: 1 })).map((m) => m.id)).toEqual([m1.id]);
  expect((await store.list({ limit: 10, offset: 0, uploadedBy: u1.id })).map((m) => m.id)).toEqual([
    m1.id,
  ]);

  expect((await store.updateAlt(m1.id, 'changed'))?.alt).toBe('changed');
  expect(await store.updateAlt(9999, 'x')).toBeUndefined();

  expect(await store.delete(m1.id)).toBe(true);
  expect(await store.delete(m1.id)).toBe(false);

  // Files stay in the library when their uploader is deleted.
  await users.delete(u2.id);
  expect((await store.findById(m2.id))?.uploadedBy).toBeNull();
}

describe('media store', () => {
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
