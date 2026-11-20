import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, createPluginsStore, createSqlRunner, type DatabaseHandle } from './index.js';

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function exercise(h: DatabaseHandle): Promise<void> {
  const store = createPluginsStore(h);
  expect(await store.list()).toEqual([]);
  expect(await store.get('notes')).toBeUndefined();

  await store.upsert({ name: 'notes', version: '1.0.0', enabled: false });
  await store.upsert({ name: 'forms', version: '0.2.0', enabled: true });
  expect(await store.get('notes')).toEqual({ name: 'notes', version: '1.0.0', enabled: false });

  await store.upsert({ name: 'notes', version: '1.1.0', enabled: true });
  expect(await store.list()).toEqual([
    { name: 'forms', version: '0.2.0', enabled: true },
    { name: 'notes', version: '1.1.0', enabled: true },
  ]);

  // Plugin-owned migrations run as written, on the same database.
  const runner = createSqlRunner(h);
  expect(runner.dialect).toBe(h.dialect);
  await runner.run('create table np_plugin_test (id integer primary key)');
  await runner.run('insert into np_plugin_test (id) values (1)');
  await expect(runner.run('this is not sql')).rejects.toThrow();
}

describe('plugins store', () => {
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
