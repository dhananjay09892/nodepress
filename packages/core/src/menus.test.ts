import { describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import {
  createMenuService,
  isSafeMenuUrl,
  MAX_MENU_DEPTH,
  MAX_MENU_ITEMS,
  MenuNotFoundError,
  MenuValidationError,
  parseMenuItems,
} from './menus.js';
import { createOptionsService, type OptionRow, type OptionsStore } from './options.js';

function setup() {
  const rows = new Map<string, OptionRow>();
  const store: OptionsStore = {
    getAutoloaded: async () => [...rows.values()].map((r) => ({ ...r })),
    get: async (key) => rows.get(key),
    upsert: async (row) => void rows.set(row.key, { ...row }),
    delete: async (key) => rows.delete(key),
  };
  const options = createOptionsService({ store, hooks: new HookRegistry() });
  return { menus: createMenuService({ options }), options };
}

const link = (label: string, url = '/x', children: unknown[] = []) => ({ label, url, children });

describe('isSafeMenuUrl', () => {
  it.each(['/', '/about', 'https://example.com/a?b=1', 'http://example.com', 'mailto:a@b.co', 'tel:+1 555-0100'])(
    'accepts %s',
    (url) => expect(isSafeMenuUrl(url)).toBe(true),
  );
  it.each([
    '',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<b>',
    '//evil.example',
    '/\\evil.example',
    'about',
    'https://',
    'https://a b.example',
    '/a\nb',
    'vbscript:x',
  ])('refuses %j', (url) => expect(isSafeMenuUrl(url)).toBe(false));
});

describe('parseMenuItems', () => {
  it('cleans items, drops unknown properties and defaults children', () => {
    expect(
      parseMenuItems([{ label: ' Home ', url: '/', target: '_blank', evil: 1 }, link('B')]),
    ).toEqual([
      { label: 'Home', url: '/', target: '_blank', children: [] },
      { label: 'B', url: '/x', children: [] },
    ]);
  });

  it('names the field that is wrong', () => {
    const field = (value: unknown) => {
      try {
        parseMenuItems(value);
      } catch (error) {
        return (error as MenuValidationError).field;
      }
      return undefined;
    };
    expect(field('x')).toBe('items');
    expect(field([1])).toBe('items[0]');
    expect(field([link('')])).toBe('items[0].label');
    expect(field([link('A', 'javascript:alert(1)')])).toBe('items[0].url');
    expect(field([{ label: 'A', url: '/', target: '_top' }])).toBe('items[0].target');
    expect(field([link('A', '/', [link('B', 'nope')])])).toBe('items[0].children[0].url');
    expect(field([{ label: 'A', url: '/', children: 'x' }])).toBe('items[0].children');
  });

  it('limits depth and size', () => {
    let nested: unknown[] = [];
    for (let i = 0; i < MAX_MENU_DEPTH; i++) nested = [link('n', '/x', nested)];
    expect(() => parseMenuItems(nested)).not.toThrow();
    expect(() => parseMenuItems([link('too deep', '/x', nested)])).toThrow(/levels deep/);
    const many = Array.from({ length: MAX_MENU_ITEMS + 1 }, (_, i) => link(`i${i}`));
    expect(() => parseMenuItems(many)).toThrow(/at most/);
  });
});

describe('MenuService', () => {
  it('creates, reads, updates and lists menus with increasing ids', async () => {
    const { menus } = setup();
    const a = await menus.create({ name: ' Main ', items: [link('Home', '/')] });
    const b = await menus.create({ name: 'Footer' });
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(a.name).toBe('Main');
    expect(b.items).toEqual([]);
    expect(await menus.get(1)).toEqual(a);
    expect(await menus.get(9)).toBeUndefined();

    const updated = await menus.update(1, { items: [link('About', '/about')] });
    expect(updated).toEqual({ id: 1, name: 'Main', items: [link('About', '/about')] });
    expect((await menus.update(1, { name: 'Primary' })).items).toEqual(updated.items);
    expect((await menus.list()).map((m) => m.name)).toEqual(['Primary', 'Footer']);
    await expect(menus.update(9, { name: 'x' })).rejects.toBeInstanceOf(MenuNotFoundError);
  });

  it('rejects bad input and saves nothing', async () => {
    const { menus } = setup();
    await expect(menus.create({ name: '' })).rejects.toBeInstanceOf(MenuValidationError);
    await expect(menus.create({ name: 5 })).rejects.toBeInstanceOf(MenuValidationError);
    await expect(
      menus.create({ name: 'Ok', items: [link('A', 'javascript:alert(1)')] }),
    ).rejects.toBeInstanceOf(MenuValidationError);
    expect(await menus.list()).toEqual([]);
  });

  it('never reuses the id of a deleted menu', async () => {
    const { menus } = setup();
    await menus.create({ name: 'One' });
    expect(await menus.delete(1)).toBe(true);
    expect(await menus.delete(1)).toBe(false);
    expect((await menus.create({ name: 'Two' })).id).toBe(2);
  });

  it('does not lose menus created at the same moment', async () => {
    const { menus } = setup();
    await Promise.all(['a', 'b', 'c', 'd'].map((name) => menus.create({ name })));
    expect((await menus.list()).map((m) => m.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it('assigns menus to the theme locations only', async () => {
    const { menus } = setup();
    const main = await menus.create({ name: 'Main', items: [link('Home', '/')] });
    const known = ['primary', 'footer'];
    expect(await menus.setLocations({ primary: main.id }, known)).toEqual({ primary: main.id });
    expect(await menus.setLocations({ footer: main.id }, known)).toEqual({
      primary: main.id,
      footer: main.id,
    });
    expect(await menus.setLocations({ footer: null }, known)).toEqual({ primary: main.id });
    await expect(menus.setLocations({ sidebar: main.id }, known)).rejects.toThrow(/not a menu location/);
    await expect(menus.setLocations({ primary: 99 }, known)).rejects.toThrow(/does not exist/);
    await expect(menus.setLocations({ primary: '1' }, known)).rejects.toThrow(/menu id or null/);
    expect(await menus.getLocations()).toEqual({ primary: main.id });
  });

  it('returns the items of assigned menus for a theme and frees locations on delete', async () => {
    const { menus } = setup();
    const main = await menus.create({ name: 'Main', items: [link('Home', '/')] });
    await menus.setLocations({ primary: main.id }, ['primary', 'footer']);
    expect(await menus.forLocations(['primary', 'footer'])).toEqual({ primary: main.items });
    await menus.delete(main.id);
    expect(await menus.forLocations(['primary'])).toEqual({});
    expect(await menus.getLocations()).toEqual({});
  });
});
