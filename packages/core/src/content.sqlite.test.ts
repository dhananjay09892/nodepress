import {
  createContentStore,
  createDatabase,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContentService, type ContentService } from './content.js';
import { HookRegistry } from './hooks.js';

let handle: DatabaseHandle;
let content: ContentService;
let userId: number;

beforeEach(async () => {
  handle = createDatabase({ url: ':memory:' });
  await handle.migrate();
  content = createContentService({ store: createContentStore(handle), hooks: new HookRegistry() });
  const user = await createUsersStore(handle).insert({
    email: 'author@example.com',
    passwordHash: 'x',
    displayName: 'Author',
    role: 'author',
  });
  userId = user.id;
});

afterEach(async () => {
  await handle.close();
});

describe('ContentService on in-memory SQLite', () => {
  it('creates, updates, revises, trashes and deletes', async () => {
    const body = [{ type: 'paragraph', text: 'Hello' }];
    const post = await content.create(
      { type: 'post', title: 'Hello World', body, status: 'published' },
      { userId },
    );
    expect(post).toMatchObject({ slug: 'hello-world', authorId: userId, status: 'published' });
    expect(post.publishedAt).toBeInstanceOf(Date);

    const second = await content.create({ type: 'post', title: 'Hello World' }, { userId });
    expect(second.slug).toBe('hello-world-2');

    const edited = await content.update(
      post.id,
      { title: 'Hello again', excerpt: 'x' },
      { userId },
    );
    expect(edited).toMatchObject({ title: 'Hello again', slug: 'hello-world', excerpt: 'x' });
    expect(edited.body).toEqual(body);

    const revisions = await content.listRevisions(post.id);
    expect(revisions.map((r) => r.snapshot.title)).toEqual(['Hello again', 'Hello World']);
    expect(revisions[1]?.snapshot.publishedAt).toBe(post.publishedAt?.toISOString());
    expect(revisions[0]?.authorId).toBe(userId);

    await content.trash(post.id, { userId });
    expect((await content.list({ type: 'post' })).map((p) => p.id)).toEqual([second.id]);
    expect((await content.restore(post.id)).status).toBe('draft');

    expect(await content.delete(post.id)).toBe(true);
    expect(await content.getBySlug('post', 'hello-world')).toBeUndefined();
    expect(await content.listRevisions(post.id)).toEqual([]);
  });

  it('keeps the unique slug index as the last line of defence', async () => {
    const store = createContentStore(handle);
    const a = await content.create({ type: 'post', title: 'Dup' });
    await expect(
      store.insert({
        type: 'post',
        status: 'draft',
        title: 'Dup',
        slug: a.slug,
        body: [],
        excerpt: null,
        authorId: null,
        parentId: null,
        publishedAt: null,
      }),
    ).rejects.toThrow();
  });
});
