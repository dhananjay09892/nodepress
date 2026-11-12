import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import {
  buildPatch,
  canAutosave,
  createContent,
  describeRevision,
  describeSaveError,
  EMPTY_STATE,
  fetchContent,
  fetchRevisions,
  isDirty,
  isoToLocalInput,
  localInputToIso,
  saveLabel,
  statusChoices,
  toEditState,
  updateContent,
  type EditState,
  type RevisionItem,
} from './post-edit.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

const paragraph = (text: string) => ({
  type: 'core/paragraph',
  content: [{ text }],
});

const saved: EditState = {
  title: 'Hello',
  slug: 'hello',
  excerpt: '',
  status: 'draft',
  publishedAt: '',
  body: [paragraph('one')],
};

describe('date conversion', () => {
  it('round-trips a timestamp through a datetime-local value (to the minute)', () => {
    const iso = '2027-03-04T05:06:00.000Z';
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
  });

  it('treats empty as no date and rejects garbage', () => {
    expect(isoToLocalInput(null)).toBe('');
    expect(isoToLocalInput('not a date')).toBe('');
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('   ')).toBeNull();
    expect(localInputToIso('nope')).toBeUndefined();
  });
});

describe('toEditState', () => {
  it('maps an item or a revision snapshot onto the form', () => {
    const state = toEditState({
      title: 'T',
      slug: 's',
      excerpt: null,
      status: 'published',
      publishedAt: null,
      body: [],
    });
    expect(state).toEqual({ ...EMPTY_STATE, title: 'T', slug: 's', status: 'published' });
  });
});

describe('buildPatch', () => {
  it('is empty when nothing changed', () => {
    expect(buildPatch({ ...saved }, saved)).toEqual({});
    expect(isDirty({ ...saved }, saved)).toBe(false);
  });

  it('sends only the changed fields', () => {
    const patch = buildPatch({ ...saved, title: 'New', body: [paragraph('two')] }, saved);
    expect(patch).toEqual({ title: 'New', body: [paragraph('two')] });
  });

  it('turns a blank excerpt into null and a cleared date into null', () => {
    const before = { ...saved, excerpt: 'x', publishedAt: '2027-01-01T10:00' };
    const patch = buildPatch({ ...before, excerpt: '  ', publishedAt: '' }, before);
    expect(patch).toEqual({ excerpt: null, publishedAt: null });
  });

  it('converts a chosen publish date to ISO and skips an invalid one', () => {
    const iso = buildPatch({ ...saved, publishedAt: '2027-01-01T10:00' }, saved).publishedAt;
    expect(iso).toBe(new Date('2027-01-01T10:00').toISOString());
    expect(buildPatch({ ...saved, publishedAt: 'garbage' }, saved)).toEqual({});
  });

  it('can leave the status out (autosave) and never sends trash', () => {
    const changed = { ...saved, status: 'published' as const };
    expect(buildPatch(changed, saved)).toEqual({ status: 'published' });
    expect(buildPatch(changed, saved, { includeStatus: false })).toEqual({});
    const trashed = { ...saved, status: 'trash' as const };
    expect(buildPatch({ ...trashed, title: 'Back' }, trashed)).toEqual({ title: 'Back' });
    expect(buildPatch(trashed, saved)).toEqual({});
  });
});

describe('screen rules', () => {
  it('autosaves drafts only', () => {
    expect(canAutosave(saved)).toBe(true);
    for (const status of ['published', 'scheduled', 'private', 'trash'] as const) {
      expect(canAutosave({ ...saved, status })).toBe(false);
    }
  });

  it('offers trash as a choice only for an item already in the trash', () => {
    expect(statusChoices('draft')).toEqual(['draft', 'scheduled', 'published', 'private']);
    expect(statusChoices('trash')[0]).toBe('trash');
  });

  it('labels the save button for the status', () => {
    expect(saveLabel(true, 'draft')).toBe('Save draft');
    expect(saveLabel(false, 'draft')).toBe('Save changes');
    expect(saveLabel(true, 'published')).toBe('Publish');
    expect(saveLabel(false, 'published')).toBe('Update');
    expect(saveLabel(false, 'scheduled')).toBe('Schedule');
  });

  it('describes revisions by position', () => {
    const rev = (id: number, title: string): RevisionItem => ({
      id,
      contentId: 1,
      authorId: 1,
      createdAt: '2027-01-01T00:00:00.000Z',
      snapshot: { title, slug: 's', status: 'draft', body: [], excerpt: null, publishedAt: null },
    });
    expect(describeRevision(rev(3, 'C'), 0, 3)).toBe('Latest: C (draft)');
    expect(describeRevision(rev(2, 'B'), 1, 3)).toBe('Version 2: B (draft)');
    expect(describeRevision(rev(1, ''), 2, 3)).toBe('First: (no title) (draft)');
  });
});

describe('API calls', () => {
  it('fetches an item and its revisions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ item: { id: 7, title: 'Hi' } }))
      .mockResolvedValueOnce(json({ revisions: [{ id: 2 }, { id: 1 }] }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchContent('post', 7)).title).toBe('Hi');
    expect(await fetchRevisions('post', 7)).toHaveLength(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/content/post/7');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/content/post/7/revisions');
  });

  it('creates and updates with the CSRF token', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ item: { id: 9 } }));
    vi.stubGlobal('fetch', fetchMock);
    await createContent('page', { title: 'A' }, 'csrf-1');
    await updateContent('page', 9, { title: 'B' }, 'csrf-2');
    const [createUrl, createInit] = fetchMock.mock.calls[0]!;
    expect(createUrl).toBe('/api/v1/content/page');
    expect(createInit.method).toBe('POST');
    expect(new Headers(createInit.headers).get('x-csrf-token')).toBe('csrf-1');
    expect(JSON.parse(createInit.body)).toEqual({ title: 'A' });
    const [updateUrl, updateInit] = fetchMock.mock.calls[1]!;
    expect(updateUrl).toBe('/api/v1/content/page/9');
    expect(updateInit.method).toBe('PATCH');
    expect(new Headers(updateInit.headers).get('x-csrf-token')).toBe('csrf-2');
  });

  it('turns an error response into an ApiError with the API code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'forbidden' }, 403)));
    await expect(updateContent('post', 1, {}, 't')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'not_found' }, 404)));
    await expect(fetchContent('post', 1)).rejects.toMatchObject({ status: 404 });
  });

  it('encodes the content type in the path', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ item: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchContent('a/b', 1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/content/a%2Fb/1');
  });
});

describe('describeSaveError', () => {
  it('explains the errors an edit can hit', () => {
    expect(describeSaveError(new ApiError(400, 'invalid_request'))).toMatch(/slug|publish date/);
    expect(describeSaveError(new ApiError(404, 'not_found'))).toMatch(/no longer exists/);
    expect(describeSaveError(new ApiError(401, 'unauthorized'))).toMatch(/signed out/);
    expect(describeSaveError(new ApiError(403, 'forbidden'))).toMatch(/permission/);
    expect(describeSaveError(new TypeError('network'))).toMatch(/Could not reach/);
  });
});
