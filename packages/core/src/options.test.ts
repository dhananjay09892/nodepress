import { describe, expect, it, vi } from 'vitest';
import { HookRegistry } from './hooks.js';
import { createOptionsService, type OptionRow, type OptionsStore } from './options.js';

/** In-memory store that counts reads, so cache behaviour can be asserted. */
function memoryStore(initial: OptionRow[] = []) {
  const rows = new Map(initial.map((r) => [r.key, { ...r }]));
  const calls = { getAutoloaded: 0, get: 0, upsert: 0, delete: 0 };
  const store: OptionsStore = {
    async getAutoloaded() {
      calls.getAutoloaded++;
      return [...rows.values()].filter((r) => r.autoload).map((r) => ({ ...r }));
    },
    async get(key) {
      calls.get++;
      const row = rows.get(key);
      return row ? { ...row } : undefined;
    },
    async upsert(row) {
      calls.upsert++;
      rows.set(row.key, { ...row });
    },
    async delete(key) {
      calls.delete++;
      return rows.delete(key);
    },
  };
  return { store, rows, calls };
}

function setup(initial: OptionRow[] = []) {
  const mem = memoryStore(initial);
  const hooks = new HookRegistry();
  const options = createOptionsService({ store: mem.store, hooks });
  return { ...mem, hooks, options };
}

describe('OptionsService', () => {
  it('returns the fallback for a missing option', async () => {
    const { options } = setup();
    expect(await options.get('nope')).toBeUndefined();
    expect(await options.get('nope', 42)).toBe(42);
    expect(await options.has('nope')).toBe(false);
  });

  it('round-trips JSON values', async () => {
    const { options } = setup();
    const values = ['text', 3, true, null, [1, 2], { a: { b: [1] } }];
    for (const [i, v] of values.entries()) {
      await options.set(`k${i}`, v);
      expect(await options.get(`k${i}`)).toEqual(v);
    }
  });

  it('reads autoloaded options once at load and serves them from cache', async () => {
    const { options, calls } = setup([
      { key: 'site_name', value: 'My site', autoload: true },
      { key: 'big', value: 'x', autoload: false },
    ]);
    expect(await options.get('site_name')).toBe('My site');
    expect(await options.get('site_name')).toBe('My site');
    expect(calls.getAutoloaded).toBe(1);
    expect(calls.get).toBe(0);
    expect(await options.getAutoloaded()).toEqual({ site_name: 'My site' });
  });

  it('fetches non-autoloaded options on demand, then caches them (and misses)', async () => {
    const { options, calls } = setup([{ key: 'big', value: [1], autoload: false }]);
    expect(await options.get('big')).toEqual([1]);
    expect(await options.get('big')).toEqual([1]);
    expect(calls.get).toBe(1);
    await options.get('absent');
    await options.get('absent');
    expect(calls.get).toBe(2);
    expect(await options.getAutoloaded()).toEqual({});
  });

  it('does not let callers mutate the cache', async () => {
    const { options } = setup();
    const input = { list: [1] };
    await options.set('o', input);
    input.list.push(2);
    const out = (await options.get('o')) as { list: number[] };
    out.list.push(3);
    expect(await options.get('o')).toEqual({ list: [1] });
  });

  it('persists autoload and keeps it on later sets unless changed', async () => {
    const { options, rows } = setup();
    await options.set('a', 1, { autoload: false });
    expect(rows.get('a')).toEqual({ key: 'a', value: 1, autoload: false });
    await options.set('a', 2);
    expect(rows.get('a')?.autoload).toBe(false);
    await options.set('a', 2, { autoload: true });
    expect(rows.get('a')?.autoload).toBe(true);
    await options.set('b', 1);
    expect(rows.get('b')?.autoload).toBe(true);
  });

  it('fires option:updated with new and old values, only when something changed', async () => {
    const { options, hooks, calls } = setup();
    const seen: unknown[][] = [];
    hooks.addAction('option:updated', (...args) => void seen.push(args));

    expect(await options.set('a', 1)).toBe(true);
    expect(await options.set('a', 1)).toBe(false);
    expect(await options.set('a', { x: 1 })).toBe(true);
    expect(await options.set('a', { x: 1 })).toBe(false);

    expect(calls.upsert).toBe(2);
    expect(seen).toEqual([
      ['a', 1, undefined],
      ['a', { x: 1 }, 1],
    ]);
  });

  it('applies the option:value filter to stored values and fallbacks', async () => {
    const { options, hooks } = setup();
    await options.set('greeting', 'hello');
    hooks.addFilter('option:value', (value, ctx) =>
      ctx.key === 'greeting' ? String(value).toUpperCase() : value,
    );
    expect(await options.get('greeting')).toBe('HELLO');
    expect(await options.get('other', 'fallback')).toBe('fallback');
    hooks.addFilter('option:value', (value, ctx) => (ctx.key === 'other' ? 'filtered' : value));
    expect(await options.get('other', 'fallback')).toBe('filtered');
  });

  it('a throwing filter or action listener never breaks the service', async () => {
    const { options, hooks } = setup();
    hooks.addFilter('option:value', () => {
      throw new Error('boom');
    });
    hooks.addAction('option:updated', () => {
      throw new Error('boom');
    });
    await expect(options.set('a', 1)).resolves.toBe(true);
    expect(await options.get('a')).toBe(1);
  });

  it('delete removes the option, fires option:deleted and reports absence', async () => {
    const { options, hooks } = setup([{ key: 'a', value: 1, autoload: true }]);
    const deleted = vi.fn();
    hooks.addAction('option:deleted', deleted);

    expect(await options.delete('a')).toBe(true);
    expect(await options.get('a')).toBeUndefined();
    expect(await options.delete('a')).toBe(false);
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(deleted).toHaveBeenCalledWith('a', 1);

    await options.set('a', 2); // setting after a delete works (negative cache is cleared)
    expect(await options.get('a')).toBe(2);
  });

  it('rejects empty keys and values that cannot be stored', async () => {
    const { options } = setup();
    await expect(options.get('')).rejects.toThrow(TypeError);
    await expect(options.set('', 1)).rejects.toThrow(TypeError);
    await expect(options.set('u', undefined)).rejects.toThrow(/undefined/);
    await expect(options.set('f', () => 1)).rejects.toThrow(/serialisable/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(options.set('c', circular)).rejects.toThrow(/serialisable/);
  });

  it('reload() picks up changes made behind the cache', async () => {
    const { options, rows } = setup([{ key: 'a', value: 1, autoload: true }]);
    expect(await options.get('a')).toBe(1);
    rows.set('a', { key: 'a', value: 2, autoload: true });
    expect(await options.get('a')).toBe(1);
    await options.reload();
    expect(await options.get('a')).toBe(2);
  });

  it('retries loading after a store failure', async () => {
    const { store } = setup();
    let fail = true;
    const flaky: OptionsStore = {
      ...store,
      async getAutoloaded() {
        if (fail) throw new Error('db down');
        return [];
      },
    };
    const options = createOptionsService({ store: flaky, hooks: new HookRegistry() });
    await expect(options.get('a')).rejects.toThrow('db down');
    fail = false;
    expect(await options.get('a', 'ok')).toBe('ok');
  });
});
