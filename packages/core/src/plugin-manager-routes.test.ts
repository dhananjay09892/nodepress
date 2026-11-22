import { describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import { silentLogger } from './logger.js';
import type { ParameterizedSqlRunner } from './plugin-db.js';
import { PluginManager } from './plugins.js';

const handler = () => ({ json: { ok: true } });

function runner() {
  const calls: string[] = [];
  const r: ParameterizedSqlRunner = {
    dialect: 'sqlite',
    async query(statement) {
      calls.push(statement);
      return [];
    },
    async execute(statement) {
      calls.push(statement);
    },
  };
  return { r, calls };
}

describe('plugin routes and database in the plugin manager', () => {
  it('adds routes under the plugin name and removes them on deactivation', async () => {
    const manager = new PluginManager(new HookRegistry(), silentLogger, {});
    manager.register({
      name: 'shop',
      setup: ({ routes }) => routes.add({ method: 'GET', path: '/items', capability: 'public', handler }),
    });
    await manager.activateAll();
    expect(manager.routes.match('shop', 'GET', '/items')).toBeDefined();
    expect(manager.list()[0]?.routes).toEqual([
      { method: 'GET', path: '/items', capability: 'public' },
    ]);
    await manager.deactivate('shop');
    expect(manager.routes.match('shop', 'GET', '/items')).toBeUndefined();
    expect(manager.list()[0]?.routes).toEqual([]);
  });

  it('leaves nothing behind when setup throws after adding a route', async () => {
    const manager = new PluginManager(new HookRegistry(), silentLogger, {});
    manager.register({
      name: 'broken',
      setup: ({ routes }) => {
        routes.add({ method: 'GET', path: '/a', capability: 'public', handler });
        throw new Error('nope');
      },
    });
    manager.register({
      name: 'fine',
      setup: ({ routes }) => routes.add({ method: 'GET', path: '/a', capability: 'public', handler }),
    });
    await manager.activateAll();
    expect(manager.routes.match('broken', 'GET', '/a')).toBeUndefined();
    expect(manager.routes.match('fine', 'GET', '/a')).toBeDefined();
    expect(manager.list().find((p) => p.name === 'broken')?.status).toBe('failed');
  });

  it('refuses an invalid route in setup, which fails only that plugin', async () => {
    const manager = new PluginManager(new HookRegistry(), silentLogger, {});
    manager.register({
      name: 'bad',
      setup: ({ routes }) =>
        routes.add({ method: 'GET', path: 'no-slash', capability: 'public', handler }),
    });
    await manager.activateAll();
    expect(manager.list()[0]?.status).toBe('failed');
  });

  it('gives context.db only to a package that declares the database permission', async () => {
    const { r, calls } = runner();
    const manager = new PluginManager(new HookRegistry(), silentLogger, {});
    manager.useDatabase(r);
    const seen: Record<string, boolean> = {};
    for (const [name, permissions] of [
      ['with-db', ['database']],
      ['without-db', ['content:read']],
    ] as const) {
      manager.register(
        {
          name,
          setup: async ({ db }) => {
            seen[name] = db !== undefined;
            if (db) {
              await db.query('SELECT id FROM with_db_items WHERE id = ?', [1]);
              // Another plugin's or core's tables are refused.
              await expect(db.query('SELECT * FROM users')).rejects.toThrow(/not one of/);
            }
          },
        },
        { permissions },
      );
    }
    manager.register({ name: 'built-in', setup: ({ db }) => void (seen['built-in'] = db !== undefined) });
    await manager.activateAll();
    expect(seen).toEqual({ 'with-db': true, 'without-db': false, 'built-in': false });
    expect(calls).toEqual(['SELECT id FROM with_db_items WHERE id = ?']);
  });

  it('gives no context.db without a database on the site', async () => {
    const manager = new PluginManager(new HookRegistry(), silentLogger, {});
    let present: boolean | undefined;
    manager.register({ name: 'p', setup: ({ db }) => void (present = db !== undefined) }, { permissions: ['database'] });
    await manager.activateAll();
    expect(present).toBe(false);
  });
});
