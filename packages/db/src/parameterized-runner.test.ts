import { afterEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createParameterizedRunner,
  createSqlRunner,
  type DatabaseHandle,
} from './index.js';

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function exercise(h: DatabaseHandle): Promise<void> {
  const setup = createSqlRunner(h);
  await setup.run('drop table if exists np_param_test');
  await setup.run('create table np_param_test (id integer primary key, name text, note text)');
  const runner = createParameterizedRunner(h);
  expect(runner.dialect).toBe(h.dialect);

  await runner.execute('insert into np_param_test (id, name, note) values (?, ?, ?)', [
    1,
    'plain',
    null,
  ]);
  // Quotes and SQL in a value are data, never part of the statement.
  const hostile = "x'); drop table np_param_test; --";
  await runner.execute('insert into np_param_test (id, name, note) values (?, ?, ?)', [
    2,
    hostile,
    'y',
  ]);

  const all = await runner.query('select id, name, note from np_param_test order by id', []);
  expect(all).toEqual([
    { id: 1, name: 'plain', note: null },
    { id: 2, name: hostile, note: 'y' },
  ]);
  expect(await runner.query('select name from np_param_test where id = ?', [2])).toEqual([
    { name: hostile },
  ]);

  await runner.execute('update np_param_test set note = ? where id = ?', ['changed', 1]);
  await runner.execute('delete from np_param_test where id = ?', [2]);
  expect(await runner.query('select id, note from np_param_test', [])).toEqual([
    { id: 1, note: 'changed' },
  ]);

  // A wrong number of values is refused before anything runs.
  await expect(runner.query('select * from np_param_test where id = ?', [])).rejects.toThrow(
    /placeholder/,
  );
}

describe('parameterized runner', () => {
  it('binds values on SQLite', async () => {
    handle = createDatabase({ url: ':memory:' });
    await handle.migrate();
    await exercise(handle);
  });

  it.skipIf(!POSTGRES_URL)('binds values on PostgreSQL', async () => {
    handle = createDatabase({ url: POSTGRES_URL! });
    await handle.migrate();
    await exercise(handle);
  });
});
