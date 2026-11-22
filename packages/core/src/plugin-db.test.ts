import { describe, expect, it } from 'vitest';
import {
  PluginSqlError,
  checkPluginSql,
  createPluginDatabase,
  pluginTablePrefix,
  type ParameterizedSqlRunner,
} from './plugin-db.js';

const ok = (sql: string, values: unknown[] = []) => checkPluginSql('my-plugin', sql, values);
const refused = (sql: string, values: unknown[] = [], message?: RegExp) =>
  expect(() => ok(sql, values)).toThrow(message ?? PluginSqlError);

describe('checkPluginSql', () => {
  it('names the prefix from the plugin name', () => {
    expect(pluginTablePrefix('my-plugin')).toBe('my_plugin_');
  });

  it('allows statements on the plugin tables', () => {
    ok('SELECT id, name FROM my_plugin_items WHERE id = ? ORDER BY id LIMIT ?', [1, 5]);
    ok('select count(*) as n from my_plugin_items;');
    ok('INSERT INTO my_plugin_items (name, qty) VALUES (?, ?)', ['x', 1]);
    ok('UPDATE my_plugin_items SET qty = qty + 1 WHERE id = ?', [1]);
    ok('DELETE FROM my_plugin_items WHERE id = ?', [1]);
    ok('SELECT a.id FROM my_plugin_a a JOIN my_plugin_b b ON b.a_id = a.id WHERE a.id = ?', [1]);
    ok('SELECT id FROM my_plugin_a, my_plugin_b WHERE 1 = 1');
    ok('SELECT id FROM my_plugin_a WHERE id IN (SELECT a_id FROM my_plugin_b)');
    ok(
      'INSERT INTO my_plugin_items (id, qty) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET qty = excluded.qty',
      [1, 2],
    );
  });

  it('refuses core tables and other plugins, in every position', () => {
    refused('SELECT * FROM users', [], /not one of this plugin's tables/);
    refused('SELECT * FROM my_plugin_a JOIN users ON 1 = 1');
    refused('SELECT * FROM my_plugin_a, users');
    refused('SELECT * FROM my_plugin_a WHERE id IN (SELECT id FROM options)');
    refused('INSERT INTO content (title) VALUES (?)', ['x']);
    refused('UPDATE options SET value = ?', ['x']);
    refused('DELETE FROM users');
    refused('SELECT * FROM my_plugin_a WHERE x = (SELECT value FROM options LIMIT 1)');
    refused('SELECT * FROM my_plugin_');
    refused('SELECT * FROM other_plugin_items');
    refused('SELECT * FROM my_pluginx');
    refused('INSERT INTO my_plugin_a SELECT * FROM users');
  });

  it('refuses system objects, table-valued functions and schema statements', () => {
    refused('SELECT * FROM sqlite_master', [], /not one of|System tables/);
    refused('SELECT * FROM pragma_table_info(?)', ['users']);
    refused('SELECT * FROM generate_series(1, 3)');
    refused('SELECT * FROM information_schema.tables');
    refused('PRAGMA table_info(users)');
    refused('DROP TABLE my_plugin_items');
    refused('CREATE TABLE my_plugin_x (id int)');
    refused('ALTER TABLE my_plugin_x ADD c int');
    refused('WITH t AS (SELECT 1) SELECT * FROM t', [], /Only SELECT/);
    refused('ATTACH DATABASE x AS y');
    refused('SELECT 1; SELECT * FROM users', [], /one statement/);
  });

  it('refuses quotes, comments, odd characters and mismatched placeholders', () => {
    refused("SELECT * FROM my_plugin_a WHERE n = 'x'", [], /Quotes/);
    refused('SELECT * FROM "users"', [], /Quotes/);
    refused('SELECT * FROM `users`', [], /Quotes/);
    refused('SELECT * FROM [users]', [], /Quotes/);
    refused('SELECT * FROM my_plugin_a -- x', [], /Comments/);
    refused('SELECT * FROM my_plugin_a /* x */', [], /Comments/);
    refused('SELECT * FROM my_plugin_a WHERE id = ?', [], /placeholder/);
    refused('SELECT * FROM my_plugin_a', [1], /placeholder/);
    refused('', [], /empty/);
    refused('SELECT * FROM my_plugin_a\u0000');
  });
});

describe('createPluginDatabase', () => {
  function fakeRunner() {
    const calls: Array<{ kind: string; statement: string; values: readonly unknown[] }> = [];
    const runner: ParameterizedSqlRunner = {
      dialect: 'sqlite',
      async query(statement, values) {
        calls.push({ kind: 'query', statement, values });
        return [{ id: 1 }];
      },
      async execute(statement, values) {
        calls.push({ kind: 'execute', statement, values });
      },
    };
    return { runner, calls };
  }

  it('passes checked statements and their values to the runner, never the values in the text', async () => {
    const { runner, calls } = fakeRunner();
    const db = createPluginDatabase('my-plugin', runner);
    expect(db.prefix).toBe('my_plugin_');
    expect(await db.query('SELECT id FROM my_plugin_a WHERE n = ?', ['x'])).toEqual([{ id: 1 }]);
    await db.execute('DELETE FROM my_plugin_a WHERE id = ?', [3]);
    expect(calls).toEqual([
      { kind: 'query', statement: 'SELECT id FROM my_plugin_a WHERE n = ?', values: ['x'] },
      { kind: 'execute', statement: 'DELETE FROM my_plugin_a WHERE id = ?', values: [3] },
    ]);
  });

  it('keeps reads and writes apart and never reaches the runner with a refused statement', async () => {
    const { runner, calls } = fakeRunner();
    const db = createPluginDatabase('my-plugin', runner);
    await expect(db.query('DELETE FROM my_plugin_a')).rejects.toThrow(/Use execute/);
    await expect(db.execute('SELECT * FROM my_plugin_a')).rejects.toThrow(/Use query/);
    await expect(db.query('SELECT * FROM users')).rejects.toThrow(PluginSqlError);
    expect(calls).toEqual([]);
  });
});
