import { describe, expect, it, vi } from 'vitest';
import { createNodePress } from './kernel.js';
import { definePlugin } from './plugins.js';
import { silentLogger } from './logger.js';
import { HookRegistry } from './hooks.js';
import {
  ContentTypeError,
  ContentTypeRegistry,
  UnknownContentTypeError,
  createContentTypeRegistry,
  type ContentTypeDefinition,
} from './content-types.js';

const product: ContentTypeDefinition = {
  name: 'product',
  label: 'Product',
  fields: [
    { name: 'sku', type: 'text', required: true, pattern: '^[A-Z]{3}-\\d+$' },
    { name: 'price', type: 'number', required: true, min: 0 },
    { name: 'stock', type: 'number', integer: true, default: 0 },
    { name: 'on_sale', type: 'boolean', default: false },
    { name: 'released', type: 'date' },
    { name: 'size', type: 'select', options: ['s', 'm', 'l'] },
    { name: 'tags', type: 'select', options: ['a', 'b', 'c'], multiple: true },
    { name: 'photo', type: 'media' },
    { name: 'gallery', type: 'media', multiple: true },
    { name: 'related', type: 'relation', target: 'product', multiple: true },
    { name: 'details', type: 'richtext' },
  ],
};

describe('built-in types', () => {
  it('registers post and page', () => {
    const registry = createContentTypeRegistry();
    expect(registry.list().map((t) => t.name)).toEqual(['post', 'page']);
    expect(registry.get('page')?.hierarchical).toBe(true);
    expect(registry.get('post')?.builtin).toBe(true);
  });

  it('cannot be replaced or removed', () => {
    const registry = createContentTypeRegistry();
    expect(() => registry.register({ name: 'post' })).toThrow(/built in/);
    expect(() => registry.unregister('page')).toThrow(ContentTypeError);
  });
});

describe('registration', () => {
  it('registers a custom type with defaults for labels', () => {
    const registry = createContentTypeRegistry();
    const type = registry.register({ name: 'event' });
    expect(type).toMatchObject({ label: 'Event', labelPlural: 'Events', builtin: false });
    expect(registry.has('event')).toBe(true);
  });

  it('rejects duplicates', () => {
    const registry = createContentTypeRegistry();
    registry.register({ name: 'event' });
    expect(() => registry.register({ name: 'event' })).toThrow(/already registered/);
  });

  it.each([
    ['bad name', { name: 'Not Valid' }],
    ['duplicate field', { name: 'x', fields: [{ name: 'a', type: 'boolean' }, { name: 'a', type: 'boolean' }] }],
    ['bad field name', { name: 'x', fields: [{ name: 'Bad-Name', type: 'boolean' }] }],
    ['unknown field type', { name: 'x', fields: [{ name: 'a', type: 'blob' }] }],
    ['select without options', { name: 'x', fields: [{ name: 'a', type: 'select', options: [] }] }],
    ['duplicate options', { name: 'x', fields: [{ name: 'a', type: 'select', options: ['a', 'a'] }] }],
    ['min > max', { name: 'x', fields: [{ name: 'a', type: 'number', min: 5, max: 1 }] }],
    ['bad pattern', { name: 'x', fields: [{ name: 'a', type: 'text', pattern: '(' }] }],
    ['default outside options', { name: 'x', fields: [{ name: 'a', type: 'select', options: ['a'], default: 'z' }] }],
    ['default breaks max', { name: 'x', fields: [{ name: 'a', type: 'number', max: 1, default: 5 }] }],
    ['unknown key', { name: 'x', fields: [{ name: 'a', type: 'boolean', bogus: 1 }] }],
  ])('rejects %s', (_label, def) => {
    const registry = createContentTypeRegistry();
    expect(() => registry.register(def as unknown as ContentTypeDefinition)).toThrow(
      ContentTypeError,
    );
    expect(registry.has('x')).toBe(false);
  });

  it('unregisters custom types', () => {
    const registry = createContentTypeRegistry();
    registry.register({ name: 'event' });
    expect(registry.unregister('event')).toBe(true);
    expect(registry.unregister('event')).toBe(false);
    expect(registry.has('event')).toBe(false);
  });

  it('fires content-type:registered', () => {
    const hooks = new HookRegistry();
    const seen: string[] = [];
    hooks.addAction('content-type:registered', (t) => {
      seen.push(t.name);
    });
    new ContentTypeRegistry({ hooks }).register({ name: 'event' });
    expect(seen).toEqual(['event']);
  });
});

describe('validation', () => {
  const registry = createContentTypeRegistry();
  registry.register(product);
  const valid = { sku: 'ABC-1', price: 9.5 };

  it('accepts valid values and applies defaults', () => {
    const result = registry.validate('product', valid);
    expect(result).toEqual({ ok: true, value: { ...valid, stock: 0, on_sale: false } });
  });

  it('accepts every field type', () => {
    const result = registry.validate('product', {
      ...valid,
      released: '2026-03-01',
      size: 'm',
      tags: ['a', 'c'],
      photo: 4,
      gallery: [1, 2],
      related: [7],
      details: [{ type: 'paragraph', children: [{ type: 'text', text: 'hi' }] }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.released).toBe('2026-03-01T00:00:00.000Z');
  });

  it('reports required fields', () => {
    const result = registry.validate('product', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path).sort()).toEqual(['price', 'sku']);
  });

  it.each([
    ['sku', 'abc'],
    ['price', -1],
    ['price', Number.NaN],
    ['price', '5'],
    ['stock', 1.5],
    ['on_sale', 'yes'],
    ['released', 'not a date'],
    ['released', '2026-13-45'],
    ['size', 'xl'],
    ['tags', ['a', 'zz']],
    ['tags', 'a'],
    ['photo', 0],
    ['photo', 1.5],
    ['gallery', [1, 'x']],
    ['related', ['7']],
    ['details', 'plain string'],
    ['details', [{ children: [] }]],
  ])('rejects bad %s = %j', (field, value) => {
    const result = registry.validate('product', { ...valid, [field]: value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path.split('.')[0]).toBe(field);
  });

  it('rejects unknown fields', () => {
    const result = registry.validate('product', { ...valid, surprise: 1 });
    expect(result).toMatchObject({ ok: false, issues: [{ message: 'Unknown field: surprise' }] });
  });

  it('allows null to clear optional fields but not required ones', () => {
    expect(registry.validate('product', { ...valid, size: null }).ok).toBe(true);
    expect(registry.validate('product', { ...valid, price: null }).ok).toBe(false);
  });

  it('validates partially for updates', () => {
    expect(registry.validate('product', { price: 3 }, { partial: true })).toEqual({
      ok: true,
      value: { price: 3 },
    });
    expect(registry.validate('product', { price: -3 }, { partial: true }).ok).toBe(false);
  });

  it('treats non-object input as empty', () => {
    expect(registry.validate('post', undefined)).toEqual({ ok: true, value: {} });
    expect(registry.validate('post', 'nope').ok).toBe(false);
  });

  it('throws for unknown types', () => {
    expect(() => registry.validate('ghost', {})).toThrow(UnknownContentTypeError);
  });

  it('rejects deeply nested rich text', () => {
    let block: Record<string, unknown> = { type: 'p' };
    for (let i = 0; i < 40; i++) block = { type: 'p', children: [block] };
    expect(registry.validate('product', { ...valid, details: [block] }).ok).toBe(false);
  });
});

describe('plugin path', () => {
  it('registers types contributed through the filter, skipping invalid ones', async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger, warn };
    const np = createNodePress({
      logger: silentLogger,
      plugins: [
        definePlugin({
          name: 'events',
          setup({ hooks }) {
            const extra: ContentTypeDefinition[] = [
              { name: 'event', fields: [{ name: 'starts', type: 'date', required: true }] },
              { name: 'BAD NAME' },
              { name: 'post' },
            ];
            hooks.addFilter('content-type:definitions', (defs) => [...defs, ...extra]);
          },
        }),
      ],
    });
    const registry = new ContentTypeRegistry({ hooks: np.hooks, logger });
    await np.boot();
    const added = await registry.refresh();
    expect(added.map((t) => t.name)).toEqual(['event']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(registry.validate('event', {}).ok).toBe(false);
    expect(registry.validate('event', { starts: '2026-01-01' }).ok).toBe(true);
  });

  it('drops plugin types after the plugin is deactivated', async () => {
    const np = createNodePress({
      logger: silentLogger,
      plugins: [
        definePlugin({
          name: 'events',
          setup({ hooks }) {
            hooks.addFilter('content-type:definitions', (defs) => [...defs, { name: 'event' }]);
          },
        }),
      ],
    });
    const registry = new ContentTypeRegistry({ hooks: np.hooks });
    registry.register({ name: 'direct' });
    await np.boot();
    await registry.refresh();
    expect(registry.has('event')).toBe(true);
    await np.shutdown();
    await registry.refresh();
    expect(registry.has('event')).toBe(false);
    expect(registry.has('direct')).toBe(true);
  });

  it('survives a throwing plugin filter', async () => {
    const hooks = new HookRegistry();
    hooks.addFilter('content-type:definitions', () => {
      throw new Error('boom');
    });
    hooks.addFilter('content-type:definitions', (defs) => [...defs, { name: 'ok' }]);
    const registry = new ContentTypeRegistry({ hooks });
    expect((await registry.refresh()).map((t) => t.name)).toEqual(['ok']);
  });

  it('ignores a filter that returns a non-array', async () => {
    const hooks = new HookRegistry();
    hooks.addFilter('content-type:definitions', () => 'nope' as unknown as ContentTypeDefinition[]);
    const registry = new ContentTypeRegistry({ hooks });
    expect(await registry.refresh()).toEqual([]);
    expect(registry.list()).toHaveLength(2);
  });
});
