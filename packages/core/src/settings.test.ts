import { describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import { createOptionsService, type OptionRow, type OptionsStore } from './options.js';
import {
  createSettingsService,
  SETTING_DEFAULTS,
  SettingValidationError,
  type SettingsService,
} from './settings.js';

function setup(initial: OptionRow[] = [], published: number[] = [7]) {
  const rows = new Map(initial.map((r) => [r.key, { ...r }]));
  const store: OptionsStore = {
    getAutoloaded: async () => [...rows.values()].filter((r) => r.autoload),
    get: async (key) => rows.get(key),
    upsert: async (row) => void rows.set(row.key, { ...row }),
    delete: async (key) => rows.delete(key),
  };
  const hooks = new HookRegistry();
  const options = createOptionsService({ store, hooks });
  const settings = createSettingsService({
    options,
    isPublishedPage: async (id) => published.includes(id),
  });
  const updated: string[] = [];
  hooks.addAction('option:updated', (key) => void updated.push(key));
  return { rows, settings, options, updated };
}

async function refused(settings: SettingsService, patch: Record<string, unknown>) {
  const error = await settings.update(patch).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SettingValidationError);
  return error as SettingValidationError;
}

describe('SettingsService', () => {
  it('returns the defaults when nothing was saved', async () => {
    expect(await setup().settings.getAll()).toEqual(SETTING_DEFAULTS);
  });

  it('saves valid values through the options service and reads them back', async () => {
    const { settings, options, updated } = setup();
    const all = await settings.update({
      site_title: '  My Site ',
      tagline: 'Words',
      timezone: 'europe/berlin',
      front_page_id: 7,
      posts_per_page: 25,
      discourage_search_engines: true,
      permalink_structure: '/:year/:month/:slug',
      api_public_read: true,
    });
    expect(all).toEqual({
      site_title: 'My Site',
      tagline: 'Words',
      timezone: 'Europe/Berlin',
      front_page_id: 7,
      posts_per_page: 25,
      discourage_search_engines: true,
      permalink_structure: '/:year/:month/:slug',
      api_public_read: true,
    });
    expect(await options.get('permalink_structure')).toBe('/:year/:month/:slug');
    expect(await options.get('api_public_read')).toBe(true);
    expect(updated).toContain('site_title');
  });

  it('only changes the keys it is given', async () => {
    const { settings } = setup();
    await settings.update({ site_title: 'A' });
    const all = await settings.update({ tagline: 'B' });
    expect(all.site_title).toBe('A');
    expect(all.tagline).toBe('B');
  });

  it('refuses unknown keys, including prototype names', async () => {
    const { settings } = setup();
    expect((await refused(settings, { nope: 1 })).key).toBe('nope');
    expect((await refused(settings, { toString: 1 })).key).toBe('toString');
    expect((await refused(settings, { constructor: 1 })).key).toBe('constructor');
  });

  it.each([
    ['site_title', ''],
    ['site_title', '   '],
    ['site_title', 'x'.repeat(201)],
    ['site_title', 'a\u0000b'],
    ['site_title', 5],
    ['tagline', 'x'.repeat(301)],
    ['tagline', null],
    ['timezone', 'Mars/Olympus'],
    ['timezone', ''],
    ['timezone', 3],
    ['front_page_id', 0],
    ['front_page_id', 1.5],
    ['front_page_id', '7'],
    ['front_page_id', 99],
    ['posts_per_page', 0],
    ['posts_per_page', 101],
    ['posts_per_page', 2.5],
    ['posts_per_page', '10'],
    ['discourage_search_engines', 'yes'],
    ['api_public_read', 1],
    ['permalink_structure', ''],
    ['permalink_structure', 'no-leading-slash'],
    ['permalink_structure', '/:unknown'],
    ['permalink_structure', 7],
  ])('refuses %s = %j and names the key', async (key, value) => {
    const { settings, rows } = setup();
    const error = await refused(settings, { [key]: value });
    expect(error.key).toBe(key);
    expect(rows.size).toBe(0);
  });

  it('saves nothing when one of several values is bad', async () => {
    const { settings, rows } = setup();
    await refused(settings, { site_title: 'Fine', posts_per_page: 0 });
    expect(rows.size).toBe(0);
  });

  it('accepts a null front page and falls back to defaults for invalid stored values', async () => {
    const { settings } = setup([
      { key: 'posts_per_page', value: 'lots', autoload: true },
      { key: 'front_page_id', value: 12, autoload: true },
    ]);
    const all = await settings.getAll();
    expect(all.posts_per_page).toBe(10);
    expect(all.front_page_id).toBe(12);
    expect((await settings.update({ front_page_id: null })).front_page_id).toBeNull();
  });
});
