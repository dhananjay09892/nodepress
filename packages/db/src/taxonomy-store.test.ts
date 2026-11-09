import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createContentStore,
  createDatabase,
  createTaxonomyStore,
  type DatabaseHandle,
} from './index.js';

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const content = {
  status: 'draft',
  body: [],
  excerpt: null,
  authorId: null,
  parentId: null,
  publishedAt: null,
};

async function exercise(h: DatabaseHandle): Promise<void> {
  const store = createTaxonomyStore(h);
  const contentStore = createContentStore(h);
  const post1 = await contentStore.insert({ ...content, type: 'post', title: 'One', slug: 'one' });
  const post2 = await contentStore.insert({ ...content, type: 'post', title: 'Two', slug: 'two' });
  const page = await contentStore.insert({ ...content, type: 'page', title: 'P', slug: 'p' });

  expect(await store.findContentType(post1.id)).toBe('post');
  expect(await store.findContentType(page.id)).toBe('page');
  expect(await store.findContentType(9999)).toBeUndefined();

  // Terms.
  expect(await store.findTermById(1)).toBeUndefined();
  const news = await store.insertTerm({
    taxonomy: 'category',
    name: 'News',
    slug: 'news',
    description: 'All the news',
    parentId: null,
  });
  const local = await store.insertTerm({
    taxonomy: 'category',
    name: 'Local',
    slug: 'local',
    description: null,
    parentId: news.id,
  });
  const tag = await store.insertTerm({
    taxonomy: 'tag',
    name: 'News',
    slug: 'news',
    description: null,
    parentId: null,
  });
  expect(local).toMatchObject({ parentId: news.id, description: null });

  // The same slug is fine in another taxonomy, but not within one.
  await expect(
    store.insertTerm({
      taxonomy: 'category',
      name: 'Dup',
      slug: 'news',
      description: null,
      parentId: null,
    }),
  ).rejects.toThrow();
  expect(await store.slugExists('category', 'news')).toBe(true);
  expect(await store.slugExists('category', 'news', news.id)).toBe(false);
  expect(await store.slugExists('category', 'nope')).toBe(false);
  expect(await store.findTermBySlug('tag', 'news')).toMatchObject({ id: tag.id });
  expect(await store.findTermBySlug('tag', 'local')).toBeUndefined();
  expect(await store.findTermById(news.id)).toEqual(news);

  expect((await store.listTerms('category')).map((t) => t.name)).toEqual(['Local', 'News']);
  expect(await store.listTerms('nothing')).toEqual([]);

  expect(await store.updateTerm(local.id, { name: 'Neighbourhood', description: 'd' })).toMatchObject(
    { name: 'Neighbourhood', slug: 'local', description: 'd', parentId: news.id },
  );
  expect(await store.updateTerm(local.id, {})).toMatchObject({ name: 'Neighbourhood' });
  expect(await store.updateTerm(9999, { name: 'x' })).toBeUndefined();
  expect(await store.updateTerm(9999, {})).toBeUndefined();

  // Relations: idempotent add, remove, listing, counting.
  expect(await store.listTermsForContent(post1.id)).toEqual([]);
  await store.addRelations(post1.id, [news.id, tag.id]);
  await store.addRelations(post1.id, [news.id, local.id]);
  await store.addRelations(post2.id, [local.id]);
  await store.addRelations(post2.id, []);
  expect((await store.listTermsForContent(post1.id)).map((t) => t.id).sort()).toEqual(
    [news.id, tag.id, local.id].sort(),
  );
  expect((await store.listTermsForContent(post1.id, 'category')).map((t) => t.name)).toEqual([
    'Neighbourhood',
    'News',
  ]);
  expect((await store.listTermsForContent(post1.id, 'tag')).map((t) => t.id)).toEqual([tag.id]);

  expect(await store.listContentIdsForTerms([local.id], 10, 0)).toEqual([post2.id, post1.id]);
  expect(await store.listContentIdsForTerms([news.id, local.id], 10, 0)).toEqual([
    post2.id,
    post1.id,
  ]);
  expect(await store.listContentIdsForTerms([local.id], 1, 1)).toEqual([post1.id]);
  expect(await store.listContentIdsForTerms([], 10, 0)).toEqual([]);

  const counts = await store.countContentByTerm([news.id, local.id, tag.id]);
  expect(counts.get(news.id)).toBe(1);
  expect(counts.get(local.id)).toBe(2);
  expect(counts.get(tag.id)).toBe(1);
  expect((await store.countContentByTerm([])).size).toBe(0);

  await store.removeRelations(post1.id, [local.id, 9999]);
  await store.removeRelations(post1.id, []);
  expect((await store.listTermsForContent(post1.id, 'category')).map((t) => t.id)).toEqual([
    news.id,
  ]);

  // Reparenting, then deleting a term removes its relations but not the content.
  await store.reparentChildren(news.id, null);
  expect((await store.findTermById(local.id))?.parentId).toBeNull();
  await store.reparentChildren(news.id, local.id);
  expect(await store.deleteTerm(news.id)).toBe(true);
  expect(await store.deleteTerm(news.id)).toBe(false);
  expect(await store.listTermsForContent(post1.id, 'category')).toEqual([]);
  expect(await store.findTermById(news.id)).toBeUndefined();
  expect(await store.findTermById(tag.id)).toBeDefined();
  expect(await contentStore.findById(post1.id)).toBeDefined();

  // Deleting content removes its relations.
  expect(await contentStore.delete(post2.id)).toBe(true);
  expect(await store.listContentIdsForTerms([local.id], 10, 0)).toEqual([]);
}

describe('taxonomy store', () => {
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
