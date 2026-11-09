import { describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import {
  TaxonomyError,
  TermNotFoundError,
  TermValidationError,
  UnknownTaxonomyError,
  createTaxonomyService,
  type TaxonomyService,
  type TaxonomyStore,
  type TermRecord,
} from './taxonomies.js';

/** In-memory store. `contents` maps content id → content type. */
function memoryStore(contents: Record<number, string> = { 1: 'post', 2: 'post', 3: 'page' }) {
  const terms = new Map<number, TermRecord>();
  const relations = new Set<string>();
  let nextId = 1;
  const key = (c: number, t: number) => `${c}:${t}`;
  const sorted = (list: TermRecord[]) =>
    list.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  const store: TaxonomyStore & { terms: Map<number, TermRecord>; failInsertOnce: boolean } = {
    terms,
    failInsertOnce: false,
    async insertTerm(row) {
      if (store.failInsertOnce) {
        store.failInsertOnce = false;
        // Simulate losing a race: someone else takes the slug just before our insert.
        terms.set(nextId, { ...row, id: nextId });
        nextId++;
        throw new Error('UNIQUE constraint failed');
      }
      const rec = { ...row, id: nextId++ };
      terms.set(rec.id, rec);
      return rec;
    },
    async findTermById(id) {
      return terms.get(id);
    },
    async findTermBySlug(taxonomy, slug) {
      return [...terms.values()].find((t) => t.taxonomy === taxonomy && t.slug === slug);
    },
    async slugExists(taxonomy, slug, excludeId) {
      return [...terms.values()].some(
        (t) => t.taxonomy === taxonomy && t.slug === slug && t.id !== excludeId,
      );
    },
    async updateTerm(id, patch) {
      const rec = terms.get(id);
      if (!rec) return undefined;
      const next = { ...rec, ...patch };
      terms.set(id, next);
      return next;
    },
    async deleteTerm(id) {
      for (const k of [...relations]) if (k.endsWith(`:${id}`)) relations.delete(k);
      return terms.delete(id);
    },
    async reparentChildren(from, to) {
      for (const t of terms.values()) if (t.parentId === from) t.parentId = to;
    },
    async listTerms(taxonomy) {
      return sorted([...terms.values()].filter((t) => t.taxonomy === taxonomy));
    },
    async findContentType(id) {
      return contents[id];
    },
    async addRelations(c, ids) {
      for (const t of ids) relations.add(key(c, t));
    },
    async removeRelations(c, ids) {
      for (const t of ids) relations.delete(key(c, t));
    },
    async listTermsForContent(c, taxonomy) {
      return sorted(
        [...terms.values()].filter(
          (t) => relations.has(key(c, t.id)) && (taxonomy === undefined || t.taxonomy === taxonomy),
        ),
      );
    },
    async listContentIdsForTerms(ids, limit, offset) {
      const found = new Set<number>();
      for (const k of relations) {
        const [c, t] = k.split(':').map(Number) as [number, number];
        if (ids.includes(t)) found.add(c);
      }
      return [...found].sort((a, b) => b - a).slice(offset, offset + limit);
    },
    async countContentByTerm(ids) {
      const counts = new Map<number, number>();
      for (const k of relations) {
        const t = Number(k.split(':')[1]);
        if (ids.includes(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      return counts;
    },
  };
  return store;
}

function setup(contents?: Record<number, string>) {
  const hooks = new HookRegistry();
  const store = memoryStore(contents);
  const service: TaxonomyService = createTaxonomyService({ store, hooks });
  return { hooks, store, service };
}

describe('taxonomy registry', () => {
  it('has category and tag built in', () => {
    const { service } = setup();
    expect(service.listTaxonomies().map((t) => [t.name, t.hierarchical, t.builtin])).toEqual([
      ['category', true, true],
      ['tag', false, true],
    ]);
    expect(service.getTaxonomy('category')?.contentTypes).toEqual(['post']);
  });

  it('registers and unregisters custom taxonomies', async () => {
    const { service, hooks } = setup();
    const seen: string[] = [];
    hooks.addAction('taxonomy:registered', (t) => void seen.push(t.name));
    const genre = service.register({ name: 'genre', label: 'Genres', hierarchical: true });
    expect(genre).toMatchObject({ label: 'Genres', hierarchical: true, contentTypes: null });
    await Promise.resolve();
    expect(seen).toEqual(['genre']);
    expect(() => service.register({ name: 'genre' })).toThrow(TaxonomyError);
    expect(() => service.register({ name: 'category' })).toThrow(/built in/);
    expect(() => service.register({ name: 'Bad Name' })).toThrow(TaxonomyError);
    expect(() => service.register({ name: 'x', contentTypes: ['Bad Type'] })).toThrow(
      TaxonomyError,
    );
    expect(service.unregister('genre')).toBe(true);
    expect(service.unregister('genre')).toBe(false);
    expect(() => service.unregister('tag')).toThrow(/built-in/i);
  });

  it('collects taxonomies from plugins through the filter and refreshes them away', async () => {
    const { service, hooks } = setup();
    let active = true;
    hooks.addFilter('taxonomy:definitions', (defs) =>
      active
        ? [
            ...defs,
            { name: 'topic', hierarchical: false },
            { name: 'Not valid' },
            { name: 'category' },
          ]
        : defs,
    );
    expect((await service.refresh()).map((t) => t.name)).toEqual(['topic']);
    expect(service.hasTaxonomy('topic')).toBe(true);
    active = false;
    await service.refresh();
    expect(service.hasTaxonomy('topic')).toBe(false);
    expect(service.hasTaxonomy('category')).toBe(true);
  });

  it('survives a failing filter listener', async () => {
    const { service, hooks } = setup();
    hooks.addFilter('taxonomy:definitions', () => {
      throw new Error('boom');
    });
    await expect(service.refresh()).resolves.toBeDefined();
    expect(service.hasTaxonomy('tag')).toBe(true);
  });
});

describe('terms', () => {
  it('creates terms with unique slugs per taxonomy', async () => {
    const { service } = setup();
    const a = await service.createTerm({ taxonomy: 'category', name: '  News  & Events ' });
    expect(a).toMatchObject({ name: 'News & Events', slug: 'news-events', parentId: null });
    const b = await service.createTerm({ taxonomy: 'category', name: 'News & Events' });
    expect(b.slug).toBe('news-events-2');
    const tag = await service.createTerm({ taxonomy: 'tag', name: 'News & Events' });
    expect(tag.slug).toBe('news-events');
    const c = await service.createTerm({ taxonomy: 'category', name: 'x', slug: 'Custom Slug' });
    expect(c.slug).toBe('custom-slug');
    expect(await service.getTermBySlug('category', 'custom-slug')).toMatchObject({ id: c.id });
    expect(await service.getTerm(a.id)).toMatchObject({ name: 'News & Events' });
    expect(await service.getTerm(999)).toBeUndefined();
    expect(await service.getTerm(-1)).toBeUndefined();
  });

  it('rejects bad input', async () => {
    const { service } = setup();
    await expect(service.createTerm({ taxonomy: 'nope', name: 'x' })).rejects.toThrow(
      UnknownTaxonomyError,
    );
    await expect(service.createTerm({ taxonomy: 'tag', name: '   ' })).rejects.toThrow(
      TermValidationError,
    );
    await expect(service.createTerm({ taxonomy: 'tag', name: 'x'.repeat(201) })).rejects.toThrow(
      TermValidationError,
    );
    await expect(
      service.createTerm({ taxonomy: 'tag', name: 'x', description: 'd'.repeat(5001) }),
    ).rejects.toThrow(TermValidationError);
    await expect(
      service.createTerm({ taxonomy: 'tag', name: 5 as unknown as string }),
    ).rejects.toThrow(TermValidationError);
    await expect(service.listTerms('nope')).rejects.toThrow(UnknownTaxonomyError);
  });

  it('recovers when another request takes the slug first', async () => {
    const { service, store } = setup();
    store.failInsertOnce = true;
    const term = await service.createTerm({ taxonomy: 'tag', name: 'Race' });
    expect(term.slug).toBe('race-2');
  });

  it('only allows parents in hierarchical taxonomies, within the same taxonomy', async () => {
    const { service } = setup();
    const parent = await service.createTerm({ taxonomy: 'category', name: 'Travel' });
    const child = await service.createTerm({
      taxonomy: 'category',
      name: 'Italy',
      parentId: parent.id,
    });
    expect(child.parentId).toBe(parent.id);

    const tag = await service.createTerm({ taxonomy: 'tag', name: 'Flat' });
    await expect(
      service.createTerm({ taxonomy: 'tag', name: 'Nested', parentId: tag.id }),
    ).rejects.toThrow(/not hierarchical/);
    service.register({ name: 'genre', hierarchical: true });
    await expect(
      service.createTerm({ taxonomy: 'genre', name: 'Jazz', parentId: parent.id }),
    ).rejects.toThrow(/does not exist in "genre"/);
    await expect(
      service.createTerm({ taxonomy: 'category', name: 'Ghost', parentId: 999 }),
    ).rejects.toThrow(TermValidationError);
  });

  it('updates terms, keeps slugs unique and prevents cycles', async () => {
    const { service, hooks } = setup();
    const events: string[] = [];
    hooks.addAction('term:updated', (t, prev) => void events.push(`${prev.name}>${t.name}`));
    const a = await service.createTerm({ taxonomy: 'category', name: 'A' });
    const b = await service.createTerm({ taxonomy: 'category', name: 'B', parentId: a.id });
    const c = await service.createTerm({ taxonomy: 'category', name: 'C', parentId: b.id });

    const renamed = await service.updateTerm(a.id, { name: 'Alpha', description: 'First' });
    expect(renamed).toMatchObject({ name: 'Alpha', slug: 'a', description: 'First' });
    expect(events).toEqual(['A>Alpha']);

    // A no-op update does not fire the action.
    await service.updateTerm(a.id, { name: 'Alpha' });
    expect(events).toHaveLength(1);

    expect((await service.updateTerm(b.id, { slug: 'a' })).slug).toBe('a-2');
    expect((await service.updateTerm(b.id, { slug: 'a-2' })).slug).toBe('a-2');

    await expect(service.updateTerm(a.id, { parentId: a.id })).rejects.toThrow(/own parent/);
    await expect(service.updateTerm(a.id, { parentId: c.id })).rejects.toThrow(/cycle/);
    expect((await service.updateTerm(c.id, { parentId: null })).parentId).toBeNull();
    expect((await service.updateTerm(c.id, { description: '  ' })).description).toBeNull();
    await expect(service.updateTerm(999, { name: 'x' })).rejects.toThrow(TermNotFoundError);
  });

  it('builds trees, descendants and ancestors', async () => {
    const { service } = setup();
    const travel = await service.createTerm({ taxonomy: 'category', name: 'Travel' });
    const europe = await service.createTerm({
      taxonomy: 'category',
      name: 'Europe',
      parentId: travel.id,
    });
    const italy = await service.createTerm({
      taxonomy: 'category',
      name: 'Italy',
      parentId: europe.id,
    });
    const asia = await service.createTerm({
      taxonomy: 'category',
      name: 'Asia',
      parentId: travel.id,
    });
    const food = await service.createTerm({ taxonomy: 'category', name: 'Food' });

    const tree = await service.termTree('category');
    expect(tree.map((n) => n.name)).toEqual(['Food', 'Travel']);
    expect(tree[1]?.children.map((n) => n.name)).toEqual(['Asia', 'Europe']);
    expect(tree[1]?.children[1]?.children.map((n) => n.name)).toEqual(['Italy']);

    expect((await service.descendantIds(travel.id)).sort()).toEqual(
      [europe.id, italy.id, asia.id].sort(),
    );
    expect(await service.descendantIds(food.id)).toEqual([]);
    expect(await service.descendantIds(999)).toEqual([]);
    expect((await service.ancestors(italy.id)).map((t) => t.name)).toEqual(['Europe', 'Travel']);
    expect(await service.ancestors(travel.id)).toEqual([]);
  });

  it('moves children up when a term is deleted', async () => {
    const { service, hooks } = setup();
    const deleted: string[] = [];
    hooks.addAction('term:deleted', (t) => void deleted.push(t.name));
    const top = await service.createTerm({ taxonomy: 'category', name: 'Top' });
    const mid = await service.createTerm({ taxonomy: 'category', name: 'Mid', parentId: top.id });
    const leaf = await service.createTerm({ taxonomy: 'category', name: 'Leaf', parentId: mid.id });
    await service.assignTerms(1, 'category', [mid.id]);

    expect(await service.deleteTerm(mid.id)).toBe(true);
    expect((await service.getTerm(leaf.id))?.parentId).toBe(top.id);
    expect(await service.getContentTerms(1)).toEqual([]);
    expect(await service.deleteTerm(mid.id)).toBe(false);
    expect(deleted).toEqual(['Mid']);

    await service.deleteTerm(top.id);
    expect((await service.getTerm(leaf.id))?.parentId).toBeNull();
  });

  it('finds or creates terms by name', async () => {
    const { service } = setup();
    const first = await service.findOrCreateTerm('tag', ' TypeScript ');
    const again = await service.findOrCreateTerm('tag', 'typescript');
    expect(again.id).toBe(first.id);
    const custom = await service.createTerm({ taxonomy: 'tag', name: 'C++', slug: 'cpp' });
    expect((await service.findOrCreateTerm('tag', 'c++')).id).toBe(custom.id);
    expect(await service.listTerms('tag')).toHaveLength(2);
  });
});

describe('assigning terms to content', () => {
  it('sets, adds and removes terms and announces changes', async () => {
    const { service, hooks } = setup();
    const changes: unknown[] = [];
    hooks.addAction('content:terms-changed', (info) => void changes.push(info));
    const a = await service.createTerm({ taxonomy: 'tag', name: 'A' });
    const b = await service.createTerm({ taxonomy: 'tag', name: 'B' });
    const c = await service.createTerm({ taxonomy: 'tag', name: 'C' });

    expect(
      (await service.setContentTerms(1, 'tag', [a.id, b.id, a.id])).map((t) => t.name),
    ).toEqual(['A', 'B']);
    expect((await service.setContentTerms(1, 'tag', [b.id, c.id])).map((t) => t.name)).toEqual([
      'B',
      'C',
    ]);
    expect((await service.assignTerms(1, 'tag', [a.id, b.id])).map((t) => t.name)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect((await service.removeTerms(1, 'tag', [a.id, c.id])).map((t) => t.name)).toEqual(['B']);
    expect(changes).toEqual([
      { contentId: 1, taxonomy: 'tag', termIds: [a.id, b.id], added: [a.id, b.id], removed: [] },
      { contentId: 1, taxonomy: 'tag', termIds: [b.id, c.id], added: [c.id], removed: [a.id] },
      { contentId: 1, taxonomy: 'tag', termIds: [a.id, b.id, c.id], added: [a.id], removed: [] },
      { contentId: 1, taxonomy: 'tag', termIds: [b.id], added: [], removed: [a.id, c.id] },
    ]);

    // Nothing changes → no event.
    await service.setContentTerms(1, 'tag', [b.id]);
    expect(changes).toHaveLength(4);
    await service.setContentTerms(1, 'tag', []);
    expect(await service.getContentTerms(1, 'tag')).toEqual([]);
  });

  it('keeps taxonomies separate on one item', async () => {
    const { service } = setup();
    const cat = await service.createTerm({ taxonomy: 'category', name: 'News' });
    const tag = await service.createTerm({ taxonomy: 'tag', name: 'Hot' });
    await service.assignTerms(1, 'category', [cat.id]);
    await service.assignTerms(1, 'tag', [tag.id]);
    await service.setContentTerms(1, 'tag', []);
    expect((await service.getContentTerms(1)).map((t) => t.name)).toEqual(['News']);
    expect((await service.getContentTerms(1, 'category')).map((t) => t.name)).toEqual(['News']);
    await expect(service.getContentTerms(1, 'nope')).rejects.toThrow(UnknownTaxonomyError);
    expect(await service.getContentTerms(0)).toEqual([]);
  });

  it('validates the item, the taxonomy and the terms', async () => {
    const { service } = setup();
    const tag = await service.createTerm({ taxonomy: 'tag', name: 'T' });
    const cat = await service.createTerm({ taxonomy: 'category', name: 'C' });
    await expect(service.assignTerms(99, 'tag', [tag.id])).rejects.toThrow(/does not exist/);
    await expect(service.assignTerms(1, 'tag', [cat.id])).rejects.toThrow(
      /does not exist in "tag"/,
    );
    await expect(service.assignTerms(1, 'tag', [999])).rejects.toThrow(TermValidationError);
    await expect(service.assignTerms(1, 'tag', [1.5])).rejects.toThrow(TermValidationError);
    await expect(service.assignTerms(1, 'nope', [])).rejects.toThrow(UnknownTaxonomyError);
    await expect(service.assignTerms(0, 'tag', [])).rejects.toThrow(TermValidationError);
    // Tags are limited to posts by default; item 3 is a page.
    await expect(service.assignTerms(3, 'tag', [tag.id])).rejects.toThrow(/content type "page"/);
    // A failed request changes nothing.
    expect(await service.getContentTerms(1)).toEqual([]);
  });

  it('assigns by name, creating missing terms without stray ones on failure', async () => {
    const { service, store } = setup();
    const terms = await service.setContentTermsByName(1, 'tag', ['One', 'two', 'ONE', 'Two ']);
    expect(terms.map((t) => t.name)).toEqual(['One', 'two']);
    expect(store.terms.size).toBe(2);
    await expect(service.setContentTermsByName(3, 'tag', ['Fresh'])).rejects.toThrow(
      TermValidationError,
    );
    await expect(service.setContentTermsByName(99, 'tag', ['Fresh'])).rejects.toThrow(
      TermValidationError,
    );
    expect(store.terms.size).toBe(2);
  });

  it('finds content by term, including descendants', async () => {
    const { service } = setup({ 1: 'post', 2: 'post', 3: 'post', 4: 'post' });
    const travel = await service.createTerm({ taxonomy: 'category', name: 'Travel' });
    const italy = await service.createTerm({
      taxonomy: 'category',
      name: 'Italy',
      parentId: travel.id,
    });
    const food = await service.createTerm({ taxonomy: 'category', name: 'Food' });
    await service.assignTerms(1, 'category', [travel.id]);
    await service.assignTerms(2, 'category', [italy.id]);
    await service.assignTerms(3, 'category', [italy.id, food.id]);
    await service.assignTerms(4, 'category', [food.id]);

    expect(await service.listContentIds(travel.id)).toEqual([3, 2, 1]);
    expect(await service.listContentIds(travel.id, { includeDescendants: false })).toEqual([1]);
    expect(await service.listContentIds(italy.id, { limit: 1, offset: 1 })).toEqual([2]);
    expect(await service.listContentIds(999)).toEqual([]);
    await expect(service.listContentIds(travel.id, { limit: 0 })).rejects.toThrow(
      TermValidationError,
    );
    await expect(service.listContentIds(travel.id, { limit: 101 })).rejects.toThrow(
      TermValidationError,
    );
    await expect(service.listContentIds(travel.id, { offset: -1 })).rejects.toThrow(
      TermValidationError,
    );

    const counts = await service.termCounts('category');
    expect([...counts]).toEqual(
      expect.arrayContaining([
        [travel.id, 1],
        [italy.id, 2],
        [food.id, 2],
      ]),
    );
  });
});
