import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyBulk,
  buildListQuery,
  describeBulk,
  fetchContentList,
  pageCount,
  PAGE_SIZE,
} from './content.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('buildListQuery', () => {
  it('asks for the newest edits first, excluding trash, with only the fields the list needs', () => {
    const q = new URLSearchParams(buildListQuery({ search: '', status: 'all', page: 0 }));
    expect(q.get('limit')).toBe(String(PAGE_SIZE));
    expect(q.get('offset')).toBe('0');
    expect(q.get('sort')).toBe('-updatedAt');
    expect(q.get('status')).toBe('draft,scheduled,published,private');
    expect(q.get('fields')).toContain('title');
    expect(q.has('q')).toBe(false);
  });

  it('filters by one status and offsets by page', () => {
    const q = new URLSearchParams(buildListQuery({ search: '', status: 'trash', page: 2 }));
    expect(q.get('status')).toBe('trash');
    expect(q.get('offset')).toBe(String(2 * PAGE_SIZE));
  });

  it('trims the search text, encodes it, and drops it when blank', () => {
    const raw = buildListQuery({ search: '  a&b=c  ', status: 'all', page: 0 });
    expect(new URLSearchParams(raw).get('q')).toBe('a&b=c');
    expect(raw).not.toContain('a&b');
    expect(buildListQuery({ search: '   ', status: 'all', page: 0 })).not.toContain('q=');
  });

  it('never sends a negative offset', () => {
    const q = new URLSearchParams(buildListQuery({ search: '', status: 'all', page: -3 }));
    expect(q.get('offset')).toBe('0');
  });
});

describe('pageCount', () => {
  it('rounds up and is at least one', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(PAGE_SIZE)).toBe(1);
    expect(pageCount(PAGE_SIZE + 1)).toBe(2);
  });
});

describe('fetchContentList', () => {
  it('requests the type route and returns the page', async () => {
    const page = { items: [], total: 0, limit: PAGE_SIZE, offset: 0 };
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) => json(page));
    vi.stubGlobal('fetch', fetchFn);
    expect(await fetchContentList('post', { search: 'x', status: 'draft', page: 0 })).toEqual(page);
    expect(fetchFn.mock.calls[0]?.[0]).toMatch(/^\/api\/v1\/content\/post\?/);
  });

  it('throws the API error code', async () => {
    vi.stubGlobal('fetch', async () => json({ error: 'forbidden' }, 403));
    await expect(
      fetchContentList('post', { search: '', status: 'all', page: 0 }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('applyBulk', () => {
  it('publishes with PATCH and the CSRF token', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) => json({ item: {} }));
    vi.stubGlobal('fetch', fetchFn);
    const result = await applyBulk('post', [1, 2], 'publish', 'csrf');
    expect(result).toEqual({ succeeded: [1, 2], failed: [] });
    const [path, init] = fetchFn.mock.calls[0]!;
    expect(path).toBe('/api/v1/content/post/1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ status: 'published' }));
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf');
  });

  it('trashes with DELETE and no force flag', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) => json({ item: {} }));
    vi.stubGlobal('fetch', fetchFn);
    await applyBulk('page', [7], 'trash', 'csrf');
    const [path, init] = fetchFn.mock.calls[0]!;
    expect(path).toBe('/api/v1/content/page/7');
    expect(path).not.toContain('force');
    expect(init?.method).toBe('DELETE');
  });

  it('keeps going after a failure and reports each item', async () => {
    vi.stubGlobal('fetch', async (path: string) =>
      path.endsWith('/2') ? json({ error: 'forbidden' }, 403) : json({ item: {} }),
    );
    const result = await applyBulk('post', [1, 2, 3], 'publish', 'csrf');
    expect(result.succeeded).toEqual([1, 3]);
    expect(result.failed).toEqual([{ id: 2, code: 'forbidden' }]);
  });

  it('records network failures as a generic code', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const result = await applyBulk('post', [1], 'trash', 'csrf');
    expect(result.failed).toEqual([{ id: 1, code: 'request_failed' }]);
  });
});

describe('describeBulk', () => {
  it('summarises full, partial and total outcomes', () => {
    expect(describeBulk('publish', { succeeded: [1], failed: [] })).toBe('1 item published.');
    expect(describeBulk('trash', { succeeded: [1, 2], failed: [] })).toBe(
      '2 items moved to the trash.',
    );
    expect(describeBulk('publish', { succeeded: [1], failed: [{ id: 2, code: 'x' }] })).toBe(
      '1 item published; 1 could not be changed.',
    );
    expect(describeBulk('publish', { succeeded: [], failed: [{ id: 2, code: 'x' }] })).toMatch(
      /^Could not change 1 item/,
    );
  });
});
