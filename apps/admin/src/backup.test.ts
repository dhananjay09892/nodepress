import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackupApiError,
  checkBackupFile,
  checkMediaFile,
  describeBackupError,
  fetchBackupLimit,
  importBackup,
  restoreMedia,
  summarizeBackup,
  summarizeMediaRestore,
  type BackupSummary,
} from './backup.js';

afterEach(() => vi.unstubAllGlobals());

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

const summary = (over: Partial<BackupSummary> = {}): BackupSummary => ({
  terms: 0,
  content: 0,
  menus: 0,
  widgets: 0,
  redirects: 0,
  settingsApplied: [],
  skipped: [],
  warnings: [],
  ...over,
});

describe('fetchBackupLimit', () => {
  it('returns the limit, or null when not allowed or switched off', async () => {
    stubFetch(200, { maxBytes: 1000 });
    expect(await fetchBackupLimit()).toEqual({ maxBytes: 1000, media: false });
    stubFetch(200, { maxBytes: 1000, media: true });
    expect(await fetchBackupLimit()).toEqual({ maxBytes: 1000, media: true });
    stubFetch(403);
    expect(await fetchBackupLimit()).toBeNull();
    stubFetch(404);
    expect(await fetchBackupLimit()).toBeNull();
    stubFetch(500);
    await expect(fetchBackupLimit()).rejects.toMatchObject({ status: 500 });
  });
});

describe('importBackup', () => {
  it('posts the file as JSON with the CSRF token', async () => {
    const fn = stubFetch(200, summary({ content: 2 }));
    const result = await importBackup('{"a":1}', 'tok');
    expect(result.content).toBe(2);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/backup/import');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('tok');
  });

  it('carries the explanation of a refused file', async () => {
    stubFetch(400, { error: 'invalid_export', message: 'This is not a NodePress export.' });
    const error = await importBackup('x', 't').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackupApiError);
    expect(describeBackupError(error)).toBe('This is not a NodePress export.');
  });
});

describe('checkBackupFile', () => {
  it('accepts a json file within the limit and explains the rest', () => {
    expect(checkBackupFile({ name: 'a.json', size: 10 }, 100)).toBeNull();
    expect(checkBackupFile({ name: 'a.xml', size: 10 }, 100)).toMatch(/\.json/);
    expect(checkBackupFile({ name: 'a.json', size: 0 }, 100)).toMatch(/empty/);
    expect(checkBackupFile({ name: 'a.json', size: 200 * 1024 * 1024 }, 100 * 1024 * 1024)).toMatch(
      /100 MB/,
    );
  });
});

describe('describeBackupError', () => {
  it('has a sentence per case', () => {
    expect(describeBackupError(new BackupApiError(409, 'import_running'))).toMatch(/still running/);
    expect(describeBackupError(new BackupApiError(413, 'payload_too_large'))).toMatch(/too large/);
    expect(describeBackupError(new Error('x'))).toMatch(/Something went wrong/);
  });
});

describe('summarizeBackup', () => {
  it('writes the numbers as sentences', () => {
    expect(summarizeBackup(summary({ content: 1, terms: 2 }))).toEqual([
      'Restored 1 item and 2 new categories and tags.',
    ]);
    expect(
      summarizeBackup(
        summary({ content: 5, menus: 1, redirects: 3, settingsApplied: ['site_title', 'tagline'] }),
      ),
    ).toEqual([
      'Restored 5 items and 0 new categories and tags.',
      'Also added 1 menu, 3 redirects.',
      'Settings restored: site_title, tagline.',
    ]);
  });
});

describe('media restore helpers', () => {
  it('checks the chosen zip', () => {
    expect(checkMediaFile({ name: 'media.zip', size: 10 }, 100)).toBeNull();
    expect(checkMediaFile({ name: 'MEDIA.ZIP', size: 10 }, 100)).toBeNull();
    expect(checkMediaFile({ name: 'media.json', size: 10 }, 100)).toMatch(/\.zip/);
    expect(checkMediaFile({ name: 'media.zip', size: 0 }, 100)).toMatch(/empty/);
    expect(checkMediaFile({ name: 'media.zip', size: 101 }, 100)).toMatch(/too large/);
  });

  it('posts the zip with the CSRF token and returns the result', async () => {
    const fn = stubFetch(200, { imported: 2, failed: [] });
    const result = await restoreMedia(new Blob(['zip']), 'tok');
    expect(result).toEqual({ imported: 2, failed: [] });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/backup/media');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/zip');
    expect(headers.get('x-csrf-token')).toBe('tok');
  });

  it('turns a refusal into an error carrying the server message', async () => {
    stubFetch(400, { error: 'invalid_media_backup', message: 'Not a usable zip' });
    await expect(restoreMedia(new Blob(['x']), 't')).rejects.toMatchObject({
      status: 400,
      detail: 'Not a usable zip',
    });
  });

  it('summarizes the result', () => {
    expect(summarizeMediaRestore({ imported: 1, failed: [] })).toEqual(['Restored 1 file.']);
    expect(
      summarizeMediaRestore({
        imported: 3,
        failed: [{ id: 1, file: 'media/1.png', reason: 'x' }],
      }),
    ).toEqual(['Restored 3 files.', '1 file was not restored.']);
  });

  it('mentions restored theme settings in the summary', () => {
    expect(summarizeBackup(summary({ themeSettings: { applied: true } })).join(' ')).toContain(
      'Theme settings restored.',
    );
    expect(
      summarizeBackup(summary({ themeSettings: { applied: false, reason: 'x' } })).join(' '),
    ).not.toContain('Theme settings restored.');
  });
});
