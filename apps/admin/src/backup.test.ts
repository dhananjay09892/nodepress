import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackupApiError,
  checkBackupFile,
  describeBackupError,
  fetchBackupLimit,
  importBackup,
  summarizeBackup,
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
    expect(await fetchBackupLimit()).toEqual({ maxBytes: 1000 });
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
