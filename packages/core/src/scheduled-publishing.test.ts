import { describe, expect, it } from 'vitest';
import {
  createContentService,
  type ContentRecord,
  type ContentStore,
  type RevisionRecord,
} from './content.js';
import { HookRegistry } from './hooks.js';
import { createJobQueue } from './jobs.js';
import { createScheduledPublisher, PUBLISH_JOB_TYPE } from './scheduled-publishing.js';
import { memoryJobStore } from './testing/memory-job-store.js';

const T0 = new Date('2030-06-01T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function contentStore(): ContentStore {
  const rows = new Map<number, ContentRecord>();
  const revisions: RevisionRecord[] = [];
  let nextId = 1;
  return {
    async insert(row) {
      const rec: ContentRecord = { ...row, id: nextId++, createdAt: T0, updatedAt: T0 };
      rows.set(rec.id, rec);
      return rec;
    },
    async findById(id) {
      return rows.get(id);
    },
    async findBySlug(type, slug) {
      return [...rows.values()].find((r) => r.type === type && r.slug === slug);
    },
    async slugExists(type, slug, excludeId) {
      return [...rows.values()].some(
        (r) => r.type === type && r.slug === slug && r.id !== excludeId,
      );
    },
    async update(id, patch) {
      const rec = rows.get(id);
      if (!rec) return undefined;
      const next = { ...rec, ...patch };
      rows.set(id, next);
      return next;
    },
    async delete(id) {
      return rows.delete(id);
    },
    async list(query) {
      return [...rows.values()]
        .filter((r) => !query.statuses || query.statuses.includes(r.status))
        .slice(query.offset, query.offset + query.limit);
    },
    async insertRevision(row) {
      const rev: RevisionRecord = { id: revisions.length + 1, ...row, createdAt: T0 };
      revisions.push(rev);
      return rev;
    },
    async listRevisions(contentId) {
      return revisions.filter((r) => r.contentId === contentId).reverse();
    },
    async findRevision(id) {
      return revisions.find((r) => r.id === id);
    },
  };
}

function setup() {
  let now = T0.getTime();
  const clock = () => new Date(now);
  const hooks = new HookRegistry();
  const jobStore = memoryJobStore();
  const jobs = createJobQueue({ store: jobStore, hooks, now: clock });
  const store = contentStore();
  const content = createContentService({ store, hooks, now: clock });
  const publisher = createScheduledPublisher({ content, jobs, hooks, now: clock });
  publisher.attach();
  const published: number[] = [];
  hooks.addAction('post:published', (item) => void published.push(item.id));
  return {
    hooks,
    store,
    jobs,
    jobStore,
    content,
    publisher,
    published,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('scheduled publishing', () => {
  it('publishes a scheduled post when its time comes, not before', async () => {
    const { content, jobs, advance, published } = setup();
    const when = new Date(T0.getTime() + 2 * HOUR);
    const post = await content.create({ type: 'post', title: 'Soon', status: 'scheduled', publishedAt: when });
    expect(post.status).toBe('scheduled');

    expect(await jobs.list({ type: PUBLISH_JOB_TYPE })).toHaveLength(1);
    await jobs.runDue();
    expect((await content.get(post.id))?.status).toBe('scheduled');

    advance(HOUR);
    await jobs.runDue();
    expect((await content.get(post.id))?.status).toBe('scheduled');

    advance(HOUR);
    expect(await jobs.runDue()).toMatchObject({ succeeded: 1 });
    const live = await content.get(post.id);
    expect(live?.status).toBe('published');
    expect(live?.publishedAt?.getTime()).toBe(when.getTime());
    expect(published).toEqual([post.id]);
    // The publish is a normal save, so it leaves a revision.
    expect((await content.listRevisions(post.id)).map((r) => r.snapshot.status)).toEqual([
      'published',
      'scheduled',
    ]);
  });

  it('queues a job when a draft is scheduled, and not again for an unchanged time', async () => {
    const { content, jobs } = setup();
    const when = new Date(T0.getTime() + HOUR);
    const post = await content.create({ type: 'post', title: 'Draft' });
    expect(await jobs.list()).toHaveLength(0);

    await content.update(post.id, { status: 'scheduled', publishedAt: when });
    expect(await jobs.list()).toHaveLength(1);
    await content.update(post.id, { title: 'Edited title' });
    expect(await jobs.list()).toHaveLength(1);
  });

  it('follows a reschedule: the old job does nothing, the new one publishes', async () => {
    const { content, jobs, advance } = setup();
    const post = await content.create({
      type: 'post',
      title: 'Moved',
      status: 'scheduled',
      publishedAt: new Date(T0.getTime() + HOUR),
    });
    await content.update(post.id, { publishedAt: new Date(T0.getTime() + 3 * HOUR) });
    expect(await jobs.list()).toHaveLength(2);

    advance(HOUR);
    await jobs.runDue();
    expect((await content.get(post.id))?.status).toBe('scheduled');
    advance(2 * HOUR);
    await jobs.runDue();
    expect((await content.get(post.id))?.status).toBe('published');
  });

  it('leaves items alone that were unscheduled, trashed or deleted meanwhile', async () => {
    const { content, jobs, advance, published } = setup();
    const when = new Date(T0.getTime() + HOUR);
    const make = (title: string) =>
      content.create({ type: 'post', title, status: 'scheduled', publishedAt: when });
    const a = await make('A');
    const b = await make('B');
    const c = await make('C');
    await content.update(a.id, { status: 'draft' });
    await content.trash(b.id);
    await content.delete(c.id);

    advance(HOUR);
    expect(await jobs.runDue()).toMatchObject({ processed: 3, succeeded: 3, failed: 0 });
    expect((await content.get(a.id))?.status).toBe('draft');
    expect((await content.get(b.id))?.status).toBe('trash');
    expect(published).toEqual([]);
  });

  it('retries a publish that fails and still gets there', async () => {
    const { content, store, jobs, jobStore, advance, published } = setup();
    const post = await content.create({
      type: 'post',
      title: 'Flaky',
      status: 'scheduled',
      publishedAt: new Date(T0.getTime() + HOUR),
    });
    const update = store.update.bind(store);
    let failures = 1;
    store.update = async (id, patch) => {
      if (patch.status === 'published' && failures-- > 0) throw new Error('database hiccup');
      return update(id, patch);
    };
    advance(HOUR);
    expect(await jobs.runDue()).toMatchObject({ retried: 1, succeeded: 0 });
    expect((await content.get(post.id))?.status).toBe('scheduled');
    expect([...jobStore.rows.values()][0]?.lastError).toBe('database hiccup');

    advance(60_000); // past the default backoff
    expect(await jobs.runDue()).toMatchObject({ succeeded: 1 });
    expect((await content.get(post.id))?.status).toBe('published');
    expect(published).toEqual([post.id]);
  });

  it('sweep() queues items that came due while the site was down', async () => {
    const { content, jobs, jobStore, publisher, advance } = setup();
    const post = await content.create({
      type: 'post',
      title: 'Missed',
      status: 'scheduled',
      publishedAt: new Date(T0.getTime() + HOUR),
    });
    const future = await content.create({
      type: 'post',
      title: 'Future',
      status: 'scheduled',
      publishedAt: new Date(T0.getTime() + 10 * HOUR),
    });
    jobStore.rows.clear(); // jobs lost
    advance(2 * HOUR);

    expect(await publisher.sweep()).toBe(1);
    await jobs.runDue();
    expect((await content.get(post.id))?.status).toBe('published');
    expect((await content.get(future.id))?.status).toBe('scheduled');
  });

  it('ignores malformed jobs and stops reacting after detach()', async () => {
    const { content, jobs, publisher, advance } = setup();
    await jobs.enqueue(PUBLISH_JOB_TYPE, { nonsense: true });
    expect(await jobs.runDue()).toMatchObject({ succeeded: 1 });

    publisher.detach();
    await content.create({
      type: 'post',
      title: 'No job',
      status: 'scheduled',
      publishedAt: new Date(T0.getTime() + HOUR),
    });
    advance(HOUR);
    expect((await jobs.list({ status: 'pending' })).length).toBe(0);
    publisher.attach();
    publisher.attach(); // idempotent
    expect(jobs.hasJob(PUBLISH_JOB_TYPE)).toBe(true);
  });
});
