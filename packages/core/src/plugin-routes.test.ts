import { describe, expect, it } from 'vitest';
import { PluginRouteRegistry, type PluginRouteDefinition } from './plugin-routes.js';

const handler = () => ({ json: {} });
const route = (over: Partial<PluginRouteDefinition> = {}): PluginRouteDefinition => ({
  method: 'GET',
  path: '/items',
  capability: 'manage_options',
  handler,
  ...over,
});

describe('PluginRouteRegistry', () => {
  it('matches a method and path for one plugin and captures :params', () => {
    const registry = new PluginRouteRegistry();
    registry.add('shop', route({ path: '/items/:id' }));
    registry.add('shop', route({ method: 'POST', path: '/items' }));
    registry.add('other', route({ path: '/items/:id' }));

    expect(registry.match('shop', 'GET', '/items/7')?.params).toEqual({ id: '7' });
    expect(registry.match('shop', 'GET', '/items/a%20b')?.params).toEqual({ id: 'a b' });
    expect(registry.match('shop', 'POST', '/items')?.definition.method).toBe('POST');
    expect(registry.match('shop', 'GET', '/items')).toBeUndefined();
    expect(registry.match('shop', 'GET', '/items/7/extra')).toBeUndefined();
    expect(registry.match('missing', 'GET', '/items/7')).toBeUndefined();
    expect(registry.match('other', 'GET', '/items/9')?.source).toBe('other');
    expect(registry.allowedMethods('shop', '/items')).toEqual(['POST']);
  });

  it('matches the root path and escapes regex characters in fixed segments', () => {
    const registry = new PluginRouteRegistry();
    registry.add('p', route({ path: '/' }));
    registry.add('p', route({ path: '/a.b' }));
    expect(registry.match('p', 'GET', '/')).toBeDefined();
    expect(registry.match('p', 'GET', '')).toBeDefined();
    expect(registry.match('p', 'GET', '/a.b')).toBeDefined();
    expect(registry.match('p', 'GET', '/axb')).toBeUndefined();
  });

  it('refuses a bad method, path, capability or handler, and a duplicate', () => {
    const registry = new PluginRouteRegistry();
    expect(() => registry.add('p', route({ method: 'TRACE' as never }))).toThrow(/method/);
    expect(() => registry.add('p', route({ path: 'items' }))).toThrow(/starts with/);
    expect(() => registry.add('p', route({ path: '/a/../b' }))).toThrow(/invalid segment/);
    expect(() => registry.add('p', route({ path: '/a/:id/:id' }))).toThrow(/repeats/);
    expect(() => registry.add('p', route({ path: '/a b' }))).toThrow(/invalid segment/);
    expect(() => registry.add('p', route({ capability: '' }))).toThrow(/capability/);
    expect(() => registry.add('p', route({ handler: 'x' as never }))).toThrow(/handler/);
    registry.add('p', route({ path: '/x/:id' }));
    expect(() => registry.add('p', route({ path: '/x/:other' }))).toThrow(/already has/);
  });

  it('removes only one plugin routes and lists them for the permission review', () => {
    const registry = new PluginRouteRegistry();
    registry.add('a', route({ path: '/one' }));
    registry.add('b', route({ path: '/two', capability: 'public' }));
    expect(registry.list('b')).toEqual([
      { source: 'b', method: 'GET', path: '/two', capability: 'public' },
    ]);
    registry.removeAllFromSource('a');
    expect(registry.list().map((r) => r.source)).toEqual(['b']);
  });
});
