import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import {
  createTerm,
  exactTerm,
  fetchTerms,
  orderTermTree,
  sameIds,
  tagSuggestions,
  termsById,
  toggleId,
  type TermItem,
} from './terms.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

const term = (id: number, name: string, parentId: number | null = null): TermItem => ({
  id,
  name,
  slug: name.toLowerCase(),
  parentId,
});

describe('orderTermTree', () => {
  it('puts children under their parent with a depth, alphabetical among siblings', () => {
    const rows = orderTermTree([
      term(1, 'World'),
      term(2, 'Europe', 1),
      term(3, 'Asia', 1),
      term(4, 'Art'),
      term(5, 'Spain', 2),
    ]);
    expect(rows.map((r) => [r.term.name, r.depth])).toEqual([
      ['Art', 0],
      ['World', 0],
      ['Asia', 1],
      ['Europe', 1],
      ['Spain', 2],
    ]);
  });

  it('shows a term with a missing parent at the top and survives a loop', () => {
    expect(orderTermTree([term(1, 'Orphan', 99)]).map((r) => r.depth)).toEqual([0]);
    const loop = orderTermTree([term(1, 'A', 2), term(2, 'B', 1), term(3, 'C')]);
    expect(loop.map((r) => r.term.name)).toEqual(['C']);
  });
});

describe('id helpers', () => {
  it('toggles an id in and out without changing the input', () => {
    const ids = [1, 2];
    expect(toggleId(ids, 3)).toEqual([1, 2, 3]);
    expect(toggleId(ids, 1)).toEqual([2]);
    expect(ids).toEqual([1, 2]);
  });

  it('compares id lists ignoring order', () => {
    expect(sameIds([1, 2], [2, 1])).toBe(true);
    expect(sameIds([1, 2], [1])).toBe(false);
    expect(sameIds([1, 1], [1, 2])).toBe(false);
    expect(sameIds([], [])).toBe(true);
  });
});

describe('tag suggestions', () => {
  const tags = [term(1, 'Release'), term(2, 'Prerelease'), term(3, 'News'), term(4, 'Relay')];

  it('matches case-insensitively, puts prefix matches first, and skips chosen tags', () => {
    expect(tagSuggestions(tags, [], 'rel').map((t) => t.name)).toEqual([
      'Relay',
      'Release',
      'Prerelease',
    ]);
    expect(tagSuggestions(tags, [4], 'REL').map((t) => t.name)).toEqual(['Release', 'Prerelease']);
    expect(tagSuggestions(tags, [], 'zzz')).toEqual([]);
  });

  it('limits the number of suggestions', () => {
    const many = Array.from({ length: 20 }, (_, i) => term(i + 1, `tag${i}`));
    expect(tagSuggestions(many, [], 'tag')).toHaveLength(8);
  });

  it('finds an exact name ignoring case and spaces', () => {
    expect(exactTerm(tags, '  news ')?.id).toBe(3);
    expect(exactTerm(tags, 'new')).toBeUndefined();
    expect(exactTerm(tags, '  ')).toBeUndefined();
  });

  it('looks chosen ids up in the order they were chosen', () => {
    expect(termsById(tags, [3, 99, 1]).map((t) => t.name)).toEqual(['News', 'Release']);
  });
});

describe('term requests', () => {
  it('returns the terms, and null when the person may not manage categories', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ terms: [term(1, 'News')] }))
      .mockResolvedValueOnce(json({ error: 'forbidden' }, 403))
      .mockResolvedValueOnce(json({ error: 'server_error' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchTerms('category')).toEqual([term(1, 'News')]);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/taxonomies/category/terms');
    expect(await fetchTerms('tag')).toBeNull();
    await expect(fetchTerms('tag')).rejects.toBeInstanceOf(ApiError);
  });

  it('creates a term with the CSRF token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ term: term(7, 'New') }, 201));
    vi.stubGlobal('fetch', fetchMock);
    expect(await createTerm('tag', 'New', 'csrf-1')).toEqual(term(7, 'New'));
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/v1/taxonomies/tag/terms');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-1');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'New', parentId: null });
  });

  it('turns a failed create into an ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'invalid_request' }, 400)));
    await expect(createTerm('tag', ' ', 'c')).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
