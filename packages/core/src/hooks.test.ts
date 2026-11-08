import { describe, expect, it, vi } from 'vitest';
import { HookRegistry, scopeHooks } from './hooks.js';

describe('actions', () => {
  it('runs listeners with the given arguments', async () => {
    const hooks = new HookRegistry();
    const seen: unknown[] = [];
    hooks.addAction('test:event', (a, b) => {
      seen.push(a, b);
    });
    await hooks.doAction('test:event', 1, 'two');
    expect(seen).toEqual([1, 'two']);
  });

  it('does nothing when no listeners exist', async () => {
    const hooks = new HookRegistry();
    await expect(hooks.doAction('nobody:listens')).resolves.toBeUndefined();
  });

  it('runs by priority, then insertion order', async () => {
    const hooks = new HookRegistry();
    const order: string[] = [];
    hooks.addAction('e', () => void order.push('default-1'));
    hooks.addAction('e', () => void order.push('late'), { priority: 20 });
    hooks.addAction('e', () => void order.push('early'), { priority: 1 });
    hooks.addAction('e', () => void order.push('default-2'));
    await hooks.doAction('e');
    expect(order).toEqual(['early', 'default-1', 'default-2', 'late']);
  });

  it('awaits async listeners in sequence', async () => {
    const hooks = new HookRegistry();
    const order: string[] = [];
    hooks.addAction('e', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('slow');
    });
    hooks.addAction('e', () => void order.push('fast'));
    await hooks.doAction('e');
    expect(order).toEqual(['slow', 'fast']);
  });

  it('isolates errors: other listeners still run and the caller does not throw', async () => {
    const onError = vi.fn();
    const hooks = new HookRegistry({ onError });
    const after = vi.fn();
    hooks.addAction(
      'e',
      () => {
        throw new Error('boom');
      },
      { source: 'bad-plugin' },
    );
    hooks.addAction('e', after);
    await expect(hooks.doAction('e')).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'action', hook: 'e', source: 'bad-plugin' }),
    );
  });

  it('can be removed by unsubscribe function or by reference', async () => {
    const hooks = new HookRegistry();
    const a = vi.fn();
    const b = vi.fn();
    const off = hooks.addAction('e', a);
    hooks.addAction('e', b);
    off();
    expect(hooks.removeAction('e', b)).toBe(true);
    expect(hooks.removeAction('e', b)).toBe(false);
    await hooks.doAction('e');
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(hooks.hasAction('e')).toBe(false);
  });

  it('is safe when a listener removes itself during dispatch', async () => {
    const hooks = new HookRegistry();
    const calls: string[] = [];
    const off = hooks.addAction('e', () => {
      calls.push('once');
      off();
    });
    hooks.addAction('e', () => void calls.push('always'));
    await hooks.doAction('e');
    await hooks.doAction('e');
    expect(calls).toEqual(['once', 'always', 'always']);
  });

  it('rejects non-function listeners', () => {
    const hooks = new HookRegistry();
    expect(() => hooks.addAction('e', 'nope' as never)).toThrow(TypeError);
  });
});

describe('filters', () => {
  it('passes the value through each listener in priority order', async () => {
    const hooks = new HookRegistry();
    hooks.addFilter('title', (v) => `${v as string}!`, { priority: 20 });
    hooks.addFilter('title', (v) => (v as string).toUpperCase());
    expect(await hooks.applyFilters('title', 'hello')).toBe('HELLO!');
  });

  it('returns the original value when there are no listeners', async () => {
    const hooks = new HookRegistry();
    const value = { a: 1 };
    expect(await hooks.applyFilters('none', value)).toBe(value);
  });

  it('gives listeners the context', async () => {
    const hooks = new HookRegistry();
    hooks.addFilter(
      'content',
      (html, ctx) => `${html as string} by ${(ctx as { author: string }).author}`,
    );
    expect(await hooks.applyFilters('content', 'Post', { author: 'Ada' })).toBe('Post by Ada');
  });

  it('supports async listeners', async () => {
    const hooks = new HookRegistry();
    hooks.addFilter('n', async (v) => (v as number) * 2);
    hooks.addFilter('n', (v) => (v as number) + 1);
    expect(await hooks.applyFilters('n', 5)).toBe(11);
  });

  it('discards a throwing listener’s change and continues with the previous value', async () => {
    const hooks = new HookRegistry();
    hooks.addFilter('n', (v) => (v as number) + 1);
    hooks.addFilter('n', () => {
      throw new Error('bad');
    });
    hooks.addFilter('n', (v) => (v as number) * 10);
    expect(await hooks.applyFilters('n', 1)).toBe(20);
  });
});

describe('sources, scoping and timings', () => {
  it('removes everything registered by one source', async () => {
    const hooks = new HookRegistry();
    const coreAction = vi.fn();
    hooks.addAction('e', coreAction);
    hooks.addAction('e', vi.fn(), { source: 'plugin-a' });
    hooks.addFilter('f', (v) => v, { source: 'plugin-a' });
    expect(hooks.removeAllFromSource('plugin-a')).toBe(2);
    expect(hooks.hasFilter('f')).toBe(false);
    await hooks.doAction('e');
    expect(coreAction).toHaveBeenCalledOnce();
  });

  it('scoped hooks tag listeners with their source', async () => {
    const hooks = new HookRegistry();
    const scoped = scopeHooks(hooks, 'my-plugin');
    scoped.addFilter('f', (v) => `${v as string}-scoped`);
    expect(await scoped.applyFilters('f', 'x')).toBe('x-scoped');
    hooks.removeAllFromSource('my-plugin');
    expect(await hooks.applyFilters('f', 'x')).toBe('x');
  });

  it('records timings and errors per source', async () => {
    const hooks = new HookRegistry();
    hooks.addAction('e', () => {}, { source: 'fast' });
    hooks.addAction(
      'e',
      () => {
        throw new Error('x');
      },
      { source: 'broken' },
    );
    await hooks.doAction('e');
    await hooks.doAction('e');
    const timings = hooks.getTimings();
    const broken = timings.find((t) => t.source === 'broken');
    expect(broken).toMatchObject({ kind: 'action', hook: 'e', calls: 2, errors: 2 });
    expect(timings.find((t) => t.source === 'fast')?.calls).toBe(2);
    hooks.resetTimings();
    expect(hooks.getTimings()).toEqual([]);
  });
});
