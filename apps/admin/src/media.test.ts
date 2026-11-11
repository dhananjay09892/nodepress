import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import {
  buildMediaQuery,
  deleteMedia,
  describeMediaError,
  describeUpload,
  fetchMediaPage,
  formatBytes,
  MEDIA_PAGE_SIZE,
  previewUrl,
  updateAlt,
  uploadFile,
  uploadFiles,
  type MediaItem,
} from './media.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const item = (id: number, extra: Partial<MediaItem> = {}): MediaItem => ({
  id,
  url: `/uploads/${id}.png`,
  mime: 'image/png',
  size: 10,
  width: 1,
  height: 1,
  alt: '',
  variants: {},
  uploadedBy: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe('buildMediaQuery', () => {
  it('asks for one extra item and offsets by page', () => {
    const q = new URLSearchParams(buildMediaQuery(2));
    expect(q.get('limit')).toBe(String(MEDIA_PAGE_SIZE + 1));
    expect(q.get('offset')).toBe(String(2 * MEDIA_PAGE_SIZE));
  });

  it('never sends a negative offset', () => {
    expect(new URLSearchParams(buildMediaQuery(-4)).get('offset')).toBe('0');
  });
});

describe('fetchMediaPage', () => {
  it('reports no next page when the extra item is missing', async () => {
    vi.stubGlobal('fetch', async () => json({ media: [item(1), item(2)] }));
    const page = await fetchMediaPage(0);
    expect(page.items.map((i) => i.id)).toEqual([1, 2]);
    expect(page.hasMore).toBe(false);
  });

  it('drops the extra item and reports a next page', async () => {
    const all = Array.from({ length: MEDIA_PAGE_SIZE + 1 }, (_, i) => item(i + 1));
    vi.stubGlobal('fetch', async () => json({ media: all }));
    const page = await fetchMediaPage(0);
    expect(page.items).toHaveLength(MEDIA_PAGE_SIZE);
    expect(page.hasMore).toBe(true);
  });

  it('throws the API error code', async () => {
    vi.stubGlobal('fetch', async () => json({ error: 'forbidden' }, 403));
    await expect(fetchMediaPage(0)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('uploadFile', () => {
  it('posts multipart with the CSRF token and no hand-set content type', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) =>
      json({ media: item(5) }, 201),
    );
    vi.stubGlobal('fetch', fetchFn);
    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    const created = await uploadFile(file, 'csrf');
    expect(created.id).toBe(5);
    const [path, init] = fetchFn.mock.calls[0]!;
    expect(path).toBe('/api/v1/media');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-csrf-token')).toBe('csrf');
    expect(headers.has('content-type')).toBe(false);
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get('file')).toBeInstanceOf(File);
  });

  it('throws the API error code on rejection', async () => {
    vi.stubGlobal('fetch', async () => json({ error: 'unsupported_type' }, 415));
    const file = new File(['x'], 'a.exe');
    await expect(uploadFile(file, 'csrf')).rejects.toMatchObject({ code: 'unsupported_type' });
  });
});

describe('uploadFiles', () => {
  it('keeps going after a failure and reports each file', async () => {
    const files = [new File(['a'], 'a.png'), new File(['b'], 'b.exe'), new File(['c'], 'c.png')];
    const upload = vi.fn(async (file: File) => {
      if (file.name === 'b.exe') throw new ApiError(415, 'unsupported_type');
      return item(file.name === 'a.png' ? 1 : 3);
    });
    const result = await uploadFiles(files, 'csrf', upload);
    expect(result.uploaded.map((i) => i.id)).toEqual([1, 3]);
    expect(result.failed).toEqual([{ name: 'b.exe', code: 'unsupported_type' }]);
  });

  it('records network failures as a generic code', async () => {
    const upload = async () => {
      throw new TypeError('Failed to fetch');
    };
    const result = await uploadFiles([new File(['a'], 'a.png')], 'csrf', upload);
    expect(result.failed).toEqual([{ name: 'a.png', code: 'request_failed' }]);
  });
});

describe('updateAlt and deleteMedia', () => {
  it('patches the alt text as JSON with the CSRF token', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) =>
      json({ media: item(3, { alt: 'A cat' }) }),
    );
    vi.stubGlobal('fetch', fetchFn);
    const updated = await updateAlt(3, 'A cat', 'csrf');
    expect(updated.alt).toBe('A cat');
    const [path, init] = fetchFn.mock.calls[0]!;
    expect(path).toBe('/api/v1/media/3');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ alt: 'A cat' }));
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf');
  });

  it('deletes with the CSRF token and surfaces errors', async () => {
    const fetchFn = vi.fn(
      async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchFn);
    await deleteMedia(9, 'csrf');
    const [path, init] = fetchFn.mock.calls[0]!;
    expect(path).toBe('/api/v1/media/9');
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf');

    vi.stubGlobal('fetch', async () => json({ error: 'not_found' }, 404));
    await expect(deleteMedia(9, 'csrf')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('helpers', () => {
  it('previews with the thumbnail when there is one', () => {
    expect(previewUrl(item(1))).toBe('/uploads/1.png');
    expect(previewUrl(item(1, { variants: { thumbnail: '/uploads/t.jpg' } }))).toBe(
      '/uploads/t.jpg',
    );
  });

  it('formats sizes', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('describes error codes for people', () => {
    expect(describeMediaError('too_large')).toBe('the file is too large');
    expect(describeMediaError('unsupported_type')).toBe('this file type is not allowed');
    expect(describeMediaError('whatever')).toBe('something went wrong');
  });

  it('summarises full, partial and total upload outcomes', () => {
    expect(describeUpload({ uploaded: [item(1)], failed: [] })).toBe('1 file uploaded.');
    expect(
      describeUpload({ uploaded: [item(1), item(2)], failed: [{ name: 'x.exe', code: 'empty' }] }),
    ).toBe('2 files uploaded. Could not upload x.exe (the file is empty).');
    expect(describeUpload({ uploaded: [], failed: [{ name: 'x', code: 'too_large' }] })).toBe(
      'Could not upload x (the file is too large).',
    );
  });
});
