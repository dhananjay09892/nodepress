import {
  createContentStore,
  createDatabase,
  createTaxonomyStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContentService, type ContentService } from './content.js';
import { HookRegistry } from './hooks.js';
import { createTaxonomyService, type TaxonomyService } from './taxonomies.js';

let handle: DatabaseHandle;
let content: ContentService;
let taxonomies: TaxonomyService;

beforeEach(async () => {
  handle = createDatabase({ url: ':memory:' });
  await handle.migrate();
  const hooks = new HookRegistry();
  content = createContentService({ store: createContentStore(handle), hooks });
  taxonomies = createTaxonomyService({ store: createTaxonomyStore(handle), hooks });
});

afterEach(async () => {
  await handle.close();
});

describe('TaxonomyService on in-memory SQLite', () => {
  it('manages hierarchical categories and assigns them to posts', async () => {
    const travel = await taxonomies.createTerm({ taxonomy: 'category', name: 'Travel' });
    const italy = await taxonomies.createTerm({
      taxonomy: 'category',
      name: 'Italy',
      parentId: travel.id,
    });
    const dup = await taxonomies.createTerm({ taxonomy: 'category', name: 'Travel' });
    expect(dup.slug).toBe('travel-2');

    const post = await content.create({ type: 'post', title: 'Rome', status: 'draft' });
    const other = await content.create({ type: 'post', title: 'Paris' });
    await taxonomies.setContentTerms(post.id, 'category', [italy.id]);
    await taxonomies.assignTerms(other.id, 'category', [travel.id]);

    expect(await taxonomies.listContentIds(travel.id)).toEqual([other.id, post.id]);
    expect(await taxonomies.listContentIds(travel.id, { includeDescendants: false })).toEqual([
      other.id,
    ]);
    expect((await taxonomies.termTree('category'))[0]?.children.map((t) => t.name)).toEqual([
      'Italy',
    ]);

    // Deleting a parent term re-parents its children and detaches the term from content.
    await taxonomies.deleteTerm(travel.id);
    expect((await taxonomies.getTerm(italy.id))?.parentId).toBeNull();
    expect(await taxonomies.getContentTerms(other.id)).toEqual([]);
    expect((await taxonomies.getContentTerms(post.id)).map((t) => t.name)).toEqual(['Italy']);
  });

  it('assigns tags by name and removes relations when the post is deleted', async () => {
    const post = await content.create({ type: 'post', title: 'Tagged' });
    const tags = await taxonomies.setContentTermsByName(post.id, 'tag', ['One', 'two', 'one']);
    expect(tags.map((t) => t.slug)).toEqual(['one', 'two']);

    await content.delete(post.id);
    expect(await taxonomies.getContentTerms(post.id)).toEqual([]);
    // The terms themselves remain.
    expect((await taxonomies.listTerms('tag')).map((t) => t.name)).toEqual(['One', 'two']);
    expect(await taxonomies.termCounts('tag')).toEqual(
      new Map(tags.map((t) => [t.id, 0])),
    );
  });

  it('supports custom taxonomies on any content type', async () => {
    taxonomies.register({ name: 'audience' });
    const page = await content.create({ type: 'page', title: 'About' });
    const term = await taxonomies.createTerm({ taxonomy: 'audience', name: 'Developers' });
    expect((await taxonomies.assignTerms(page.id, 'audience', [term.id])).map((t) => t.id)).toEqual(
      [term.id],
    );
  });
});
