import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createContentStore,
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

const base = {
  status: 'draft',
  body: [],
  excerpt: null,
  authorId: null,
  parentId: null,
  publishedAt: null,
};

async function exercise(h: DatabaseHandle): Promise<void> {
  const store = createContentStore(h);
  const author = await createUsersStore(h).insert({
    email: 'a@example.com',
    passwordHash: 'x',
    displayName: 'A',
    role: 'author',
  });

  expect(await store.findById(1)).toBeUndefined();
  expect(await store.slugExists('post', 'hello')).toBe(false);

  const published = new Date('2026-11-09T12:00:00.000Z');
  const body = [{ type: 'paragraph', children: [{ type: 'text', text: 'Hi' }] }];
  const a = await store.insert({
    ...base,
    type: 'post',
    title: 'Hello',
    slug: 'hello',
    status: 'published',
    body,
    excerpt: 'Short',
    authorId: author.id,
    publishedAt: published,
  });
  expect(a.createdAt).toBeInstanceOf(Date);
  expect(a.body).toEqual(body);
  expect(a.publishedAt).toEqual(published);

  // The same slug is fine for another type, but not within a type.
  const page = await store.insert({ ...base, type: 'page', title: 'Hello', slug: 'hello' });
  await expect(
    store.insert({ ...base, type: 'post', title: 'Dup', slug: 'hello' }),
  ).rejects.toThrow();
  const b = await store.insert({ ...base, type: 'post', title: 'B', slug: 'b', parentId: null });

  expect(await store.findBySlug('post', 'hello')).toMatchObject({ id: a.id });
  expect(await store.findBySlug('page', 'hello')).toMatchObject({ id: page.id });
  expect(await store.findBySlug('post', 'nope')).toBeUndefined();
  expect(await store.slugExists('post', 'hello')).toBe(true);
  expect(await store.slugExists('post', 'hello', a.id)).toBe(false);

  const updated = await store.update(b.id, { title: 'B2', status: 'private', parentId: a.id });
  expect(updated).toMatchObject({ title: 'B2', status: 'private', parentId: a.id, slug: 'b' });
  expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(b.updatedAt.getTime());
  expect(await store.update(9999, { title: 'x' })).toBeUndefined();
  expect(await store.update(b.id, {})).toMatchObject({ title: 'B2' });

  // Newest first, with filters and paging.
  expect((await store.list({ limit: 10, offset: 0 })).map((r) => r.id)).toEqual([
    b.id,
    page.id,
    a.id,
  ]);
  expect((await store.list({ type: 'post', limit: 10, offset: 0 })).map((r) => r.id)).toEqual([
    b.id,
    a.id,
  ]);
  expect(
    (await store.list({ statuses: ['published', 'draft'], limit: 10, offset: 0 })).map((r) => r.id),
  ).toEqual([page.id, a.id]);
  expect(
    (await store.list({ authorId: author.id, limit: 10, offset: 0 })).map((r) => r.id),
  ).toEqual([a.id]);
  expect((await store.list({ limit: 1, offset: 1 })).map((r) => r.id)).toEqual([page.id]);

  // Revisions.
  expect(await store.listRevisions(a.id)).toEqual([]);
  const r1 = await store.insertRevision({
    contentId: a.id,
    snapshot: { title: 'Hello', publishedAt: published.toISOString(), body },
    authorId: author.id,
  });
  const r2 = await store.insertRevision({
    contentId: a.id,
    snapshot: { title: 'v2' },
    authorId: null,
  });
  expect(r1.snapshot).toEqual({ title: 'Hello', publishedAt: published.toISOString(), body });
  expect((await store.listRevisions(a.id)).map((r) => r.id)).toEqual([r2.id, r1.id]);
  expect(await store.findRevision(r1.id)).toMatchObject({ contentId: a.id, authorId: author.id });
  expect(await store.findRevision(9999)).toBeUndefined();

  // Deleting an item deletes its revisions; deleting the author keeps the item.
  expect(await store.delete(a.id)).toBe(true);
  expect(await store.delete(a.id)).toBe(false);
  expect(await store.listRevisions(a.id)).toEqual([]);
  expect(await store.findById(b.id)).toMatchObject({ parentId: null });
}

describe('content store', () => {
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
