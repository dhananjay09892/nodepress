import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, createOptionsStore, type DatabaseHandle } from './index.js';

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

/** The same behaviour on every dialect: JSON values round-trip, upsert replaces, delete reports. */
async function exercise(h: DatabaseHandle): Promise<void> {
  const store = createOptionsStore(h);
  expect(await store.get('missing')).toBeUndefined();

  const values: unknown[] = ['text', '{"looks":"like json"}', 7, 0, false, true, [1, 'a'], { a: { b: 1 } }];
  for (const [i, value] of values.entries()) {
    await store.upsert({ key: `k${i}`, value, autoload: true });
    expect(await store.get(`k${i}`)).toEqual({ key: `k${i}`, value, autoload: true });
  }

  await store.upsert({ key: 'k0', value: 'changed', autoload: false });
  expect(await store.get('k0')).toEqual({ key: 'k0', value: 'changed', autoload: false });

  const autoloaded = await store.getAutoloaded();
  expect(autoloaded.map((r) => r.key).sort()).toEqual(values.slice(1).map((_, i) => `k${i + 1}`).sort());

  expect(await store.delete('k0')).toBe(true);
  expect(await store.delete('k0')).toBe(false);
  expect(await store.get('k0')).toBeUndefined();
}

describe('options store', () => {
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
