import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MenuApiError,
  createMenu,
  describeMenuError,
  diffLocations,
  fetchMenus,
  updateMenu,
} from './menus.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('diffLocations', () => {
  it('keeps only the locations that changed, including clearing one', () => {
    expect(
      diffLocations({ primary: 1, footer: 2 }, { primary: 1, footer: null, sidebar: 3 }),
    ).toEqual({ footer: null, sidebar: 3 });
  });

  it('does not report an unassigned location left as none', () => {
    expect(diffLocations({}, { primary: null })).toEqual({});
  });
});

describe('menus API calls', () => {
  it('returns null when the user may not edit menus', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'forbidden' }, 403)));
    expect(await fetchMenus()).toBeNull();
  });

  it('sends the CSRF token and the new name', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ menu: { id: 1, name: 'Main', items: [] } }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const menu = await createMenu('Main', 'tok');
    expect(menu.id).toBe(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/menus');
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('tok');
    expect(init.body).toBe('{"name":"Main"}');
  });

  it('carries the server field and message of a refused menu', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          json(
            { error: 'invalid_request', field: 'items[0].url', message: 'url must be safe' },
            400,
          ),
        ),
    );
    const error = await updateMenu(1, { items: [] }, 'tok').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MenuApiError);
    expect((error as MenuApiError).field).toBe('items[0].url');
    expect(describeMenuError(error)).toBe('url must be safe');
  });

  it('describes missing permission, missing menus and unknown failures', () => {
    expect(describeMenuError(new MenuApiError(403, 'forbidden'))).toContain('permission');
    expect(describeMenuError(new MenuApiError(404, 'not_found'))).toContain('no longer exists');
    expect(describeMenuError(new Error('x'))).toContain('Something went wrong');
  });
});
