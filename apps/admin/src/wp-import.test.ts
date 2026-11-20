import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkExportFile,
  describeImportError,
  fetchImportLimit,
  ImportApiError,
  importQuery,
  importWordPress,
  summarizeReport,
  type WpImportReport,
} from './wp-import.js';

afterEach(() => vi.unstubAllGlobals());

const report = (extra: Partial<WpImportReport> = {}): WpImportReport => ({
  site: { title: 'Old Site', url: 'https://old.example.com' },
  created: { posts: 1, pages: 2, categories: 0, tags: 3 },
  redirects: [],
  attachments: [],
  linksRewritten: 1,
  skipped: [],
  warnings: [],
  authorsMatched: 2,
  ...extra,
});

function stubFetch(status: number, body?: unknown) {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('importQuery', () => {
  it('is empty for the defaults and lists only what changes them', () => {
    expect(importQuery({ matchAuthors: true })).toBe('');
    expect(importQuery({ matchAuthors: false })).toBe('?match_authors=false');
    expect(importQuery({ matchAuthors: true, defaultAuthor: 7 })).toBe('?default_author=7');
    expect(importQuery({ matchAuthors: false, defaultAuthor: 7 })).toBe(
      '?default_author=7&match_authors=false',
    );
  });
});

describe('checkExportFile', () => {
  it('accepts an XML file within the limit and explains the rest', () => {
    expect(checkExportFile({ name: 'export.XML', size: 10 }, 100)).toBeNull();
    expect(checkExportFile({ name: 'export.zip', size: 10 }, 100)).toMatch(/\.xml/);
    expect(checkExportFile({ name: 'a.xml', size: 0 }, 100)).toMatch(/empty/);
    expect(checkExportFile({ name: 'a.xml', size: 101 }, 2 * 1024 * 1024)).toBeNull();
    expect(checkExportFile({ name: 'a.xml', size: 3 * 1024 * 1024 }, 2 * 1024 * 1024)).toMatch(
      /2 MB at most/,
    );
  });
});

describe('describeImportError', () => {
  it('uses the server message for a bad file and plain sentences otherwise', () => {
    expect(describeImportError(new ImportApiError(400, 'invalid_wxr', 'Not a WordPress export.'))).toBe(
      'Not a WordPress export.',
    );
    expect(describeImportError(new ImportApiError(400, 'invalid_wxr'))).toMatch(/could not use/);
    expect(describeImportError(new ImportApiError(403, 'forbidden'))).toMatch(/permission/);
    expect(describeImportError(new ImportApiError(409, 'import_running'))).toMatch(/still running/);
    expect(describeImportError(new ImportApiError(413, 'payload_too_large'))).toMatch(/too large/);
    expect(describeImportError(new ImportApiError(415, 'unsupported_media_type'))).toMatch(/\.xml/);
    expect(describeImportError(new Error('x'))).toMatch(/went wrong/);
  });
});

describe('summarizeReport', () => {
  it('writes counts with the right plurals', () => {
    const lines = summarizeReport(report());
    expect(lines[0]).toBe('Imported 1 post, 2 pages, 0 categories and 3 tags from Old Site.');
    expect(lines[1]).toBe('2 authors were matched to existing users by email.');
    expect(lines[2]).toBe('1 link between imported items was updated.');
    expect(lines).toHaveLength(3);
  });

  it('mentions saved redirects, a disabled redirects feature and undownloaded files', () => {
    const saved = summarizeReport(
      report({
        authorsMatched: 1,
        redirects: [{ from: '/a', to: '/b' }],
        redirectsSaved: { created: 1, skipped: [{ from: '/c', message: 'loop' }] },
        attachments: [{ url: 'https://x/y.png', title: 'y' }],
      }),
    );
    expect(saved).toContain('1 redirect was saved so old links keep working (1 could not be saved).');
    expect(saved).toContain('1 file is listed in the export but not downloaded yet.');
    const off = summarizeReport(report({ redirects: [{ from: '/a', to: '/b' }, { from: '/c', to: '/d' }] }));
    expect(off.some((l) => l.includes('2 old addresses') && l.includes('turned off'))).toBe(true);
  });
});

describe('API calls', () => {
  it('fetchImportLimit answers null when forbidden or off, and the limit otherwise', async () => {
    stubFetch(200, { maxBytes: 1234 });
    expect(await fetchImportLimit()).toEqual({ maxBytes: 1234 });
    stubFetch(403, { error: 'forbidden' });
    expect(await fetchImportLimit()).toBeNull();
    stubFetch(404, { error: 'not_found' });
    expect(await fetchImportLimit()).toBeNull();
    stubFetch(500, { error: 'boom' });
    await expect(fetchImportLimit()).rejects.toMatchObject({ status: 500 });
  });

  it('importWordPress posts the XML with the CSRF token and the chosen options', async () => {
    const fn = stubFetch(200, report());
    const result = await importWordPress('<rss/>', { matchAuthors: false, defaultAuthor: 3 }, 'tok');
    expect(result.created.posts).toBe(1);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/import/wordpress?default_author=3&match_authors=false');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/xml');
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('tok');
    expect(init.body).toBe('<rss/>');
  });

  it('importWordPress surfaces the server message for an unreadable export', async () => {
    stubFetch(400, { error: 'invalid_wxr', message: 'Not a WordPress export.' });
    await expect(importWordPress('x', { matchAuthors: true }, 'tok')).rejects.toMatchObject({
      status: 400,
      detail: 'Not a WordPress export.',
    });
  });
});
