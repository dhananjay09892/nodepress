import { describe, expect, it } from 'vitest';
import {
  ContentNotFoundError,
  ContentValidationError,
  createContentService,
  slugify,
  type ContentRecord,
  type ContentService,
  type ContentStore,
  type RevisionRecord,
} from './content.js';
import { HookRegistry } from './hooks.js';

function memoryStore(): ContentStore & { rows: Map<number, ContentRecord>; failInsertOnce: boolean } {
  const rows = new Map<number, ContentRecord>();
  const revisions: RevisionRecord[] = [];
  let nextId = 1;
  let nextRevision = 1;
  const store = {
    rows,
    failInsertOnce: false,
    async insert(row: Parameters<ContentStore['insert']>[0]) {
      if (store.failInsertOnce) {
        store.failInsertOnce = false;
        // Simulate losing a race: someone else takes the slug just before our insert.
        const other: ContentRecord = {
          ...row,
          id: nextId++,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.set(other.id, other);
        throw new Error('UNIQUE constraint failed');
      }
      const rec: ContentRecord = { ...row, id: nextId++, createdAt: new Date(), updatedAt: new Date() };
      rows.set(rec.id, rec);
      return rec;
    },
    async findById(id: number) {
      return rows.get(id);
    },
    async findBySlug(type: string, slug: string) {
      return [...rows.values()].find((r) => r.type === type && r.slug === slug);
    },
    async slugExists(type: string, slug: string, excludeId?: number) {
      return [...rows.values()].some(
        (r) => r.type === type && r.slug === slug && r.id !== excludeId,
      );
    },
    async update(id: number, patch: Parameters<ContentStore['update']>[1]) {
      const rec = rows.get(id);
      if (!rec) return undefined;
      const next = { ...rec, ...patch, updatedAt: new Date() };
      rows.set(id, next);
      return next;
    },
    async delete(id: number) {
      for (let i = revisions.length - 1; i >= 0; i--) {
        if (revisions[i]?.contentId === id) revisions.splice(i, 1);
      }
      return rows.delete(id);
    },
    async list(query: Parameters<ContentStore['list']>[0]) {
      return [...rows.values()]
        .filter((r) => query.type === undefined || r.type === query.type)
        .filter((r) => !query.statuses || query.statuses.includes(r.status))
        .filter((r) => query.authorId === undefined || r.authorId === query.authorId)
        .sort((a, b) => b.id - a.id)
        .slice(query.offset, query.offset + query.limit);
    },
    async insertRevision(row: Parameters<ContentStore['insertRevision']>[0]) {
      const rev: RevisionRecord = {
        id: nextRevision++,
        ...row,
        snapshot: JSON.parse(JSON.stringify(row.snapshot)),
        createdAt: new Date(),
      };
      revisions.push(rev);
      return rev;
    },
    async listRevisions(contentId: number) {
      return revisions.filter((r) => r.contentId === contentId).reverse();
    },
    async findRevision(id: number) {
      return revisions.find((r) => r.id === id);
    },
  };
  return store;
}

const NOW = new Date('2026-11-09T12:00:00.000Z');

function setup(): {
  content: ContentService;
  hooks: HookRegistry;
  store: ReturnType<typeof memoryStore>;
} {
  const hooks = new HookRegistry();
  const store = memoryStore();
  const content = createContentService({ store, hooks, now: () => NOW });
  return { content, hooks, store };
}

describe('slugify', () => {
  it('folds accents, lower-cases and collapses punctuation', () => {
    expect(slugify('  Héllo, Wörld!! 2026 ')).toBe('hello-world-2026');
    expect(slugify('---a---b---')).toBe('a-b');
  });

  it('returns an empty string for text with no latin letters or digits', () => {
    expect(slugify('你好')).toBe('');
  });

  it('caps the length and never ends with a hyphen', () => {
    const slug = slugify(`${'a'.repeat(179)} b`);
    expect(slug.length).toBeLessThanOrEqual(180);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('slugs', () => {
  it('generates a slug from the title', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', title: 'Hello World' });
    expect(post.slug).toBe('hello-world');
  });

  it('falls back to "untitled" when there is nothing to slugify', async () => {
    const { content } = setup();
    expect((await content.create({ type: 'post' })).slug).toBe('untitled');
    expect((await content.create({ type: 'post', title: '你好' })).slug).toBe('untitled-2');
  });

  it('makes slugs unique within a type, but not across types', async () => {
    const { content } = setup();
    const a = await content.create({ type: 'post', title: 'About' });
    const b = await content.create({ type: 'post', title: 'About' });
    const c = await content.create({ type: 'post', title: 'About' });
    const page = await content.create({ type: 'page', title: 'About' });
    expect([a.slug, b.slug, c.slug]).toEqual(['about', 'about-2', 'about-3']);
    expect(page.slug).toBe('about');
  });

  it('normalises and de-duplicates an explicit slug', async () => {
    const { content } = setup();
    await content.create({ type: 'post', title: 'x', slug: 'My Slug' });
    const second = await content.create({ type: 'post', title: 'y', slug: 'my slug' });
    expect(second.slug).toBe('my-slug-2');
  });

  it('keeps the slug when the title changes, and regenerates it on request', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', title: 'First' });
    const renamed = await content.update(post.id, { title: 'Second' });
    expect(renamed.slug).toBe('first');
    const regenerated = await content.update(post.id, { slug: '' });
    expect(regenerated.slug).toBe('second');
  });

  it('does not collide with itself when the slug is set to its current value', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', title: 'Same' });
    const again = await content.update(post.id, { slug: 'Same' });
    expect(again.slug).toBe('same');
  });

  it('avoids another item when renaming a slug', async () => {
    const { content } = setup();
    await content.create({ type: 'post', title: 'Taken' });
    const other = await content.create({ type: 'post', title: 'Other' });
    const moved = await content.update(other.id, { slug: 'taken' });
    expect(moved.slug).toBe('taken-2');
  });

  it('retries with a new slug when another request takes it first', async () => {
    const { content, store } = setup();
    store.failInsertOnce = true;
    const post = await content.create({ type: 'post', title: 'Race' });
    expect(post.slug).toBe('race-2');
  });

  it('rethrows insert errors that are not slug collisions', async () => {
    const { content, store } = setup();
    store.insert = async () => {
      throw new Error('disk full');
    };
    await expect(content.create({ type: 'post', title: 'x' })).rejects.toThrow('disk full');
  });
});

describe('statuses', () => {
  it('defaults to draft with no publish date', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', title: 'Draft' });
    expect(post.status).toBe('draft');
    expect(post.publishedAt).toBeNull();
  });

  it('stamps publishedAt when created as published', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', title: 'Live', status: 'published' });
    expect(post.publishedAt).toEqual(NOW);
  });

  it('keeps a past publishedAt but clamps a future one for published items', async () => {
    const { content } = setup();
    const past = new Date('2020-01-01T00:00:00Z');
    const old = await content.create({ type: 'post', status: 'published', publishedAt: past });
    expect(old.publishedAt).toEqual(past);
    const future = await content.create({
      type: 'post',
      status: 'published',
      publishedAt: new Date('2030-01-01T00:00:00Z'),
    });
    expect(future.publishedAt).toEqual(NOW);
  });

  it('publishes a draft and keeps the date when unpublished and republished', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', title: 'P' });
    const live = await content.update(post.id, { status: 'published' });
    expect(live.publishedAt).toEqual(NOW);
    const back = await content.update(post.id, { status: 'draft' });
    expect(back.publishedAt).toEqual(NOW);
    expect((await content.update(post.id, { status: 'published' })).publishedAt).toEqual(NOW);
  });

  it('requires a future date for scheduled items', async () => {
    const { content } = setup();
    await expect(content.create({ type: 'post', status: 'scheduled' })).rejects.toBeInstanceOf(
      ContentValidationError,
    );
    await expect(
      content.create({ type: 'post', status: 'scheduled', publishedAt: new Date('2020-01-01') }),
    ).rejects.toThrow(/future/);
    const when = new Date('2027-01-01T00:00:00Z');
    const post = await content.create({ type: 'post', status: 'scheduled', publishedAt: when });
    expect(post.status).toBe('scheduled');
    expect(post.publishedAt).toEqual(when);
  });

  it('rejects unknown statuses', async () => {
    const { content } = setup();
    await expect(
      content.create({ type: 'post', status: 'archived' as never }),
    ).rejects.toThrow(/status must be one of/);
  });

  it('trashes and restores as a draft', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', title: 'T', status: 'published' });
    const trashed = await content.trash(post.id);
    expect(trashed.status).toBe('trash');
    const restored = await content.restore(post.id);
    expect(restored.status).toBe('draft');
    expect((await content.restore(post.id)).status).toBe('draft');
  });

  it('restore reports unknown ids', async () => {
    const { content } = setup();
    await expect(content.restore(99)).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it('list hides trash by default and can filter by status, type and author', async () => {
    const { content } = setup();
    const a = await content.create({ type: 'post', title: 'a', authorId: 1 });
    const b = await content.create({ type: 'post', title: 'b', status: 'published', authorId: 2 });
    await content.create({ type: 'page', title: 'c' });
    await content.trash(a.id);
    expect((await content.list()).map((p) => p.title)).toEqual(['c', 'b']);
    expect((await content.list({ status: 'trash' })).map((p) => p.id)).toEqual([a.id]);
    expect((await content.list({ type: 'post', status: ['draft', 'published'] })).map((p) => p.id)).toEqual([b.id]);
    expect((await content.list({ authorId: 2 })).map((p) => p.id)).toEqual([b.id]);
    expect(await content.list({ limit: 1, offset: 1 })).toHaveLength(1);
  });

  it('list validates paging and statuses', async () => {
    const { content } = setup();
    await expect(content.list({ limit: 0 })).rejects.toBeInstanceOf(ContentValidationError);
    await expect(content.list({ limit: 101 })).rejects.toBeInstanceOf(ContentValidationError);
    await expect(content.list({ offset: -1 })).rejects.toBeInstanceOf(ContentValidationError);
    await expect(content.list({ status: 'nope' as never })).rejects.toBeInstanceOf(
      ContentValidationError,
    );
  });
});

describe('validation', () => {
  it('requires a sane content type', async () => {
    const { content } = setup();
    for (const type of ['', 'Post', '1post', 'a b', 'x'.repeat(51), 5 as never]) {
      await expect(content.create({ type })).rejects.toBeInstanceOf(ContentValidationError);
    }
    await expect(content.create({ type: 'my_type-2' })).resolves.toBeDefined();
  });

  it('checks title, excerpt, body and ids', async () => {
    const { content } = setup();
    await expect(content.create({ type: 'post', title: 'x'.repeat(501) })).rejects.toThrow(/title/);
    await expect(content.create({ type: 'post', excerpt: 'x'.repeat(5001) })).rejects.toThrow(
      /excerpt/,
    );
    await expect(content.create({ type: 'post', body: 'hi' as never })).rejects.toThrow(/body/);
    await expect(
      content.create({ type: 'post', body: [{ text: 'no type' } as never] }),
    ).rejects.toThrow(/body/);
    await expect(content.create({ type: 'post', authorId: -1 })).rejects.toThrow(/authorId/);
    await expect(
      content.create({ type: 'post', publishedAt: new Date('nope') }),
    ).rejects.toThrow(/publishedAt/);
  });

  it('stores nested blocks and trims the title', async () => {
    const { content } = setup();
    const body = [{ type: 'paragraph', children: [{ type: 'text', text: 'hi' }] }];
    const post = await content.create({ type: 'post', title: '  Padded  ', body });
    expect(post.title).toBe('Padded');
    expect(post.body).toEqual(body);
  });

  it('defaults the author to the acting user', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post' }, { userId: 7 });
    expect(post.authorId).toBe(7);
    expect((await content.create({ type: 'post', authorId: 3 }, { userId: 7 })).authorId).toBe(3);
  });

  it('validates parents: they must exist, share the type, and never form a cycle', async () => {
    const { content } = setup();
    const parent = await content.create({ type: 'page', title: 'Parent' });
    const child = await content.create({ type: 'page', title: 'Child', parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    await expect(content.create({ type: 'page', parentId: 999 })).rejects.toThrow(/does not exist/);
    await expect(content.create({ type: 'post', parentId: parent.id })).rejects.toThrow(
      /same content type/,
    );
    await expect(content.update(parent.id, { parentId: parent.id })).rejects.toThrow(/own parent/);
    await expect(content.update(parent.id, { parentId: child.id })).rejects.toThrow(/cycle/);
  });

  it('update reports unknown ids', async () => {
    const { content } = setup();
    await expect(content.update(42, { title: 'x' })).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it('reads by id and by slug, and ignores bad ids', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', title: 'Find me' });
    expect(await content.get(post.id)).toEqual(post);
    expect(await content.getBySlug('post', 'find-me')).toEqual(post);
    expect(await content.getBySlug('page', 'find-me')).toBeUndefined();
    expect(await content.get(0)).toBeUndefined();
    expect(await content.get(1.5)).toBeUndefined();
  });
});

describe('revisions', () => {
  it('saves a revision on create and on every update', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', title: 'v1' }, { userId: 1 });
    await content.update(post.id, { title: 'v2' }, { userId: 2 });
    await content.update(post.id, { body: [{ type: 'paragraph', text: 'hello' }] }, { userId: 3 });

    const revisions = await content.listRevisions(post.id);
    expect(revisions).toHaveLength(3);
    // Newest first.
    expect(revisions.map((r) => r.snapshot.title)).toEqual(['v2', 'v2', 'v1']);
    expect(revisions.map((r) => r.authorId)).toEqual([3, 2, 1]);
    expect(revisions[0]?.snapshot.body).toEqual([{ type: 'paragraph', text: 'hello' }]);
    expect(revisions[2]?.snapshot).toMatchObject({ title: 'v1', status: 'draft', slug: 'v1' });
  });

  it('snapshots the publish date as ISO text and can fetch one revision', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', title: 'p', status: 'published' });
    const [rev] = await content.listRevisions(post.id);
    expect(rev?.snapshot.publishedAt).toBe(NOW.toISOString());
    expect(await content.getRevision(rev!.id)).toEqual(rev);
    expect(await content.getRevision(999)).toBeUndefined();
  });

  it('does not save a revision or fire hooks when nothing changed', async () => {
    const { content, hooks } = setup();
    const saved: string[] = [];
    hooks.addAction('post:saved', (c) => void saved.push(c.title));
    const post = await content.create({ type: 'post', title: 'same', body: [{ type: 'p' }] });
    const same = await content.update(post.id, { title: 'same', body: [{ type: 'p' }] });
    expect(same).toEqual(post);
    expect(await content.listRevisions(post.id)).toHaveLength(1);
    expect(saved).toEqual(['same']);
  });

  it('falls back to the content author when no actor is given', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', authorId: 5 });
    expect((await content.listRevisions(post.id))[0]?.authorId).toBe(5);
  });

  it('records trashing as a revision', async () => {
    const { content } = setup();
    const post = await content.create({ type: 'post', title: 't' });
    await content.trash(post.id);
    expect((await content.listRevisions(post.id))[0]?.snapshot.status).toBe('trash');
  });
});

describe('delete', () => {
  it('removes the item and its revisions and fires post:deleted', async () => {
    const { content, hooks } = setup();
    const deleted: number[] = [];
    hooks.addAction('post:deleted', (c) => void deleted.push(c.id));
    const post = await content.create({ type: 'post', title: 'bye' });
    expect(await content.delete(post.id)).toBe(true);
    expect(await content.get(post.id)).toBeUndefined();
    expect(await content.listRevisions(post.id)).toEqual([]);
    expect(deleted).toEqual([post.id]);
    expect(await content.delete(post.id)).toBe(false);
    expect(deleted).toEqual([post.id]);
  });
});

describe('hooks', () => {
  it('lets post:saving change fields, with context for creates and updates', async () => {
    const { content, hooks } = setup();
    const seen: Array<{ isNew: boolean; id?: number | undefined; previousTitle?: string | undefined }> = [];
    hooks.addFilter('post:saving', (fields, ctx) => {
      seen.push({ isNew: ctx.isNew, id: ctx.id, previousTitle: ctx.previous?.title });
      return { ...fields, title: fields.title.toUpperCase() };
    });
    const post = await content.create({ type: 'post', title: 'shout' });
    expect(post.title).toBe('SHOUT');
    const updated = await content.update(post.id, { excerpt: 'e' });
    expect(updated.excerpt).toBe('e');
    expect(seen).toEqual([
      { isNew: true, id: undefined, previousTitle: undefined },
      { isNew: false, id: post.id, previousTitle: 'SHOUT' },
    ]);
  });

  it('lets post:saving change the status, which then follows the status rules', async () => {
    const { content, hooks } = setup();
    hooks.addFilter('post:saving', (fields) => ({ ...fields, status: 'published' as const }));
    const post = await content.create({ type: 'post', title: 'forced' });
    expect(post.status).toBe('published');
    expect(post.publishedAt).toEqual(NOW);
  });

  it('ignores a post:saving result that fails validation', async () => {
    const { content, hooks } = setup();
    hooks.addFilter('post:saving', (fields) => ({ ...fields, status: 'scheduled' as const }));
    hooks.addFilter('post:saving', (fields) => ({ ...fields, title: 'x'.repeat(9999) }), {
      priority: 20,
    });
    const post = await content.create({ type: 'post', title: 'kept' });
    expect(post.title).toBe('kept');
    expect(post.status).toBe('draft');
  });

  it('survives a throwing post:saving listener', async () => {
    const { content, hooks } = setup();
    hooks.addFilter('post:saving', () => {
      throw new Error('plugin bug');
    });
    hooks.addFilter('post:saving', (fields) => ({ ...fields, excerpt: 'still ran' }), {
      priority: 20,
    });
    const post = await content.create({ type: 'post', title: 'ok' });
    expect(post.excerpt).toBe('still ran');
  });

  it('survives a post:saving listener that returns nonsense', async () => {
    const { content, hooks } = setup();
    hooks.addFilter('post:saving', () => undefined as never);
    const post = await content.create({ type: 'post', title: 'fine' });
    expect(post.title).toBe('fine');
  });

  it('fires post:saved on create and update, with the previous version on updates', async () => {
    const { content, hooks } = setup();
    const events: string[] = [];
    hooks.addAction('post:saved', (c, info) => {
      events.push(`${c.title}|${String(info.isNew)}|${info.previous?.title ?? '-'}`);
    });
    const post = await content.create({ type: 'post', title: 'one' });
    await content.update(post.id, { title: 'two' });
    expect(events).toEqual(['one|true|-', 'two|false|one']);
  });

  it('fires post:published only when an item becomes published', async () => {
    const { content, hooks } = setup();
    const published: string[] = [];
    hooks.addAction('post:published', (c) => void published.push(c.title));

    await content.create({ type: 'post', title: 'draft' });
    const live = await content.create({ type: 'post', title: 'live', status: 'published' });
    const later = await content.create({ type: 'post', title: 'later' });
    await content.update(later.id, { status: 'published' });
    await content.update(live.id, { title: 'live edited' });
    await content.update(live.id, { status: 'draft' });
    await content.update(live.id, { status: 'published' });
    expect(published).toEqual(['live', 'later', 'live edited']);
  });

  it('fires post:trashed, and a failing listener cannot break the save', async () => {
    const { content, hooks } = setup();
    const trashed: number[] = [];
    hooks.addAction('post:saved', () => {
      throw new Error('plugin bug');
    });
    hooks.addAction('post:trashed', (c) => void trashed.push(c.id));
    const post = await content.create({ type: 'post', title: 'oops' });
    expect(await content.get(post.id)).toBeDefined();
    await content.trash(post.id);
    expect(trashed).toEqual([post.id]);
  });
});
