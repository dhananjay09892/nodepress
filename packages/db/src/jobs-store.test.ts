import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, createJobsStore, type DatabaseHandle } from './index.js';

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function exercise(h: DatabaseHandle): Promise<void> {
  const store = createJobsStore(h);
  const t0 = new Date('2030-01-01T00:00:00.000Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  const a = await store.insert({ type: 'a', payload: { n: 1 }, runAt: at(0) });
  expect(a).toMatchObject({ type: 'a', payload: { n: 1 }, attempts: 0, status: 'pending' });
  expect(a.lastError).toBeNull();
  const b = await store.insert({ type: 'b', payload: null, runAt: at(-1000) });
  const later = await store.insert({ type: 'a', payload: 'x', runAt: at(60_000) });
  expect((await store.findById(a.id))?.payload).toEqual({ n: 1 });

  // Only due jobs of the asked-for types, oldest due time first.
  expect(await store.findClaimable([], at(0))).toBeUndefined();
  expect((await store.findClaimable(['a', 'b'], at(0)))?.id).toBe(b.id);
  expect((await store.findClaimable(['a'], at(0)))?.id).toBe(a.id);
  expect((await store.findClaimable(['a'], at(-5000)))).toBeUndefined();

  // Claiming is compare-and-set: the second worker loses.
  const claimed = await store.claim(a, at(30_000));
  expect(claimed).toMatchObject({ id: a.id, status: 'running', attempts: 1 });
  expect(claimed?.runAt.getTime()).toBe(at(30_000).getTime());
  expect(await store.claim(a, at(30_000))).toBeUndefined();

  // A running job with a live lease is not claimable; with an expired lease it is.
  expect((await store.findClaimable(['a'], at(10_000)))).toBeUndefined();
  const stale = await store.findClaimable(['a'], at(31_000));
  expect(stale).toMatchObject({ id: a.id, status: 'running', attempts: 1 });
  const reclaimed = await store.claim(stale!, at(60_000));
  expect(reclaimed?.attempts).toBe(2);

  // The first (dead) worker can no longer finish the job; the current claim can.
  expect(await store.complete(a.id, 1)).toBe(false);
  expect(await store.retry(a.id, 1, at(0), 'late')).toBe(false);
  expect(await store.retry(a.id, 2, at(90_000), 'boom')).toBe(true);
  expect(await store.findById(a.id)).toMatchObject({ status: 'pending', lastError: 'boom' });
  expect((await store.findById(a.id))?.runAt.getTime()).toBe(at(90_000).getTime());

  const again = await store.claim((await store.findById(a.id))!, at(120_000));
  expect(again?.attempts).toBe(3);
  expect(await store.fail(a.id, 3, 'gave up')).toBe(true);
  expect(await store.findById(a.id)).toMatchObject({ status: 'failed', lastError: 'gave up' });
  expect(await store.fail(a.id, 3, 'twice')).toBe(false);

  // A failed job can be requeued with a fresh attempt count; others cannot.
  expect(await store.requeue(b.id, at(0))).toBe(false);
  expect(await store.requeue(a.id, at(0))).toBe(true);
  expect(await store.findById(a.id)).toMatchObject({ status: 'pending', attempts: 0 });

  const bClaim = await store.claim(b, at(1000));
  expect(await store.complete(b.id, bClaim!.attempts)).toBe(true);
  expect(await store.findById(b.id)).toMatchObject({ status: 'done', lastError: null });

  expect((await store.list({ limit: 10 })).map((j) => j.id)).toEqual([later.id, b.id, a.id]);
  expect((await store.list({ status: 'done', limit: 10 })).map((j) => j.id)).toEqual([b.id]);
  expect((await store.list({ type: 'a', limit: 1 })).map((j) => j.id)).toEqual([later.id]);

  expect(await store.purgeDone(at(0))).toBe(0);
  expect(await store.purgeDone(at(2000))).toBe(1);
  expect(await store.findById(b.id)).toBeUndefined();
}

describe('jobs store', () => {
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
