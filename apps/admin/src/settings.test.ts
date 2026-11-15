import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import {
  SECTION_KEYS,
  SettingsError,
  describeSettingsError,
  diffSettings,
  fetchPublishedPages,
  fetchSettings,
  presetFor,
  saveSettings,
  timezoneNames,
  toDraft,
  type SettingsValues,
} from './settings.js';

const saved: SettingsValues = {
  site_title: 'NodePress',
  tagline: '',
  timezone: 'UTC',
  front_page_id: null,
  posts_per_page: 10,
  discourage_search_engines: false,
  permalink_structure: '/blog/:slug',
  api_public_read: false,
};

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('diffSettings', () => {
  it('is empty for an untouched form', () => {
    for (const section of Object.keys(SECTION_KEYS) as (keyof typeof SECTION_KEYS)[]) {
      expect(diffSettings(section, saved, toDraft(saved))).toEqual({});
    }
  });

  it('sends only the changed keys of the screen, trimmed', () => {
    const draft = { ...toDraft(saved), site_title: '  Field Notes ', tagline: 'Hi', posts_per_page: '3' };
    expect(diffSettings('general', saved, draft)).toEqual({ site_title: 'Field Notes', tagline: 'Hi' });
    // posts_per_page belongs to Reading, so General never sends it.
    expect(diffSettings('reading', saved, draft)).toEqual({ posts_per_page: 3 });
  });

  it('maps the front page choice to an id or null', () => {
    const draft = { ...toDraft(saved), front_page_id: '12' };
    expect(diffSettings('reading', saved, draft)).toEqual({ front_page_id: 12 });
    const back = toDraft({ ...saved, front_page_id: 12 });
    expect(diffSettings('reading', { ...saved, front_page_id: 12 }, { ...back, front_page_id: '' })).toEqual({
      front_page_id: null,
    });
  });

  it('keeps unusable numbers as text so the server can refuse them', () => {
    expect(diffSettings('reading', saved, { ...toDraft(saved), posts_per_page: 'many' })).toEqual({
      posts_per_page: 'many',
    });
    expect(diffSettings('reading', saved, { ...toDraft(saved), posts_per_page: ' 20 ' })).toEqual({
      posts_per_page: 20,
    });
  });

  it('sends checkbox changes and a new permalink pattern', () => {
    const draft = { ...toDraft(saved), api_public_read: true, permalink_structure: '/:year/:slug' };
    expect(diffSettings('reading', saved, draft)).toEqual({ api_public_read: true });
    expect(diffSettings('permalinks', saved, draft)).toEqual({ permalink_structure: '/:year/:slug' });
  });
});

describe('helpers', () => {
  it('finds the preset of a pattern', () => {
    expect(presetFor('/blog/:slug')).toBe('/blog/:slug');
    expect(presetFor('/news/:slug')).toBe('custom');
  });

  it('lists UTC first and always includes the current zone', () => {
    const names = timezoneNames('Etc/Custom');
    expect(names[0]).toBe('UTC');
    expect(names).toContain('Etc/Custom');
    expect(new Set(names).size).toBe(names.length);
  });

  it('describes errors in plain language', () => {
    expect(describeSettingsError(new SettingsError(400, 'invalid_request', 'posts_per_page'))).toContain(
      '1 to 100',
    );
    expect(describeSettingsError(new SettingsError(400, 'invalid_request', 'permalink_structure'))).toContain(
      ':slug',
    );
    expect(describeSettingsError(new SettingsError(400, 'invalid_request', null))).toBe(
      'Check the values and try again.',
    );
    expect(describeSettingsError(new ApiError(403, 'forbidden'))).toContain('permission');
    expect(describeSettingsError(new Error('x'))).toBe('Something went wrong. Please try again.');
  });
});

describe('API calls', () => {
  it('fetches settings', async () => {
    const fn = stubFetch(200, { settings: saved });
    expect(await fetchSettings()).toEqual(saved);
    expect(fn).toHaveBeenCalledWith('/api/v1/settings', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('saves a patch with the CSRF token', async () => {
    const fn = stubFetch(200, { settings: { ...saved, tagline: 'Hi' } });
    expect((await saveSettings({ tagline: 'Hi' }, 'tok')).tagline).toBe('Hi');
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('tok');
    expect(init.body).toBe('{"tagline":"Hi"}');
  });

  it('throws an error that names the refused field', async () => {
    stubFetch(400, { error: 'invalid_request', field: 'timezone', message: 'nope' });
    const error = await saveSettings({ timezone: 'x' }, 't').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettingsError);
    expect(error).toMatchObject({ status: 400, code: 'invalid_request', field: 'timezone' });
  });

  it('lists published pages', async () => {
    stubFetch(200, { items: [{ id: 3, title: 'About', slug: 'about' }] });
    expect(await fetchPublishedPages()).toEqual([{ id: 3, title: 'About' }]);
  });
});
