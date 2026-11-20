import { describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import { createOptionsService, type OptionRow, type OptionsStore } from './options.js';
import {
  createRedirects,
  MAX_REDIRECTS,
  normalizeFrom,
  normalizeTo,
  parseCsv,
  RedirectNotFoundError,
  RedirectValidationError,
} from './redirects.js';

function memoryStore(): OptionsStore & { rows: Map<string, OptionRow> } {
  const rows = new Map<string, OptionRow>();
  return {
    rows,
    getAutoloaded: async () => [...rows.values()].filter((r) => r.autoload),
    get: async (key) => rows.get(key),
    upsert: async (row) => void rows.set(row.key, { ...row }),
    delete: async (key) => rows.delete(key),
  };
}

function setup() {
  const store = memoryStore();
  const options = createOptionsService({ store, hooks: new HookRegistry() });
  return { store, redirects: createRedirects({ options }) };
}

describe('normalizeFrom / normalizeTo', () => {
  it('cleans an old path', () => {
    expect(normalizeFrom(' /old/ ')).toBe('/old');
    expect(normalizeFrom('/blog/*')).toBe('/blog/*');
  });

  it('refuses unusable old paths', () => {
    for (const bad of [
      'old',
      '//evil.example',
      '/',
      '/a?b=1',
      '/a#x',
      '/a b',
      '/a*/b',
      '/api/v1',
      '/admin',
      '/admin/x*',
      '/uploads/a.png',
      5,
      '',
    ]) {
      expect(() => normalizeFrom(bad), String(bad)).toThrow(RedirectValidationError);
    }
    expect(() => normalizeFrom('/x'.repeat(300))).toThrow(RedirectValidationError);
    expect(normalizeFrom('/apple')).toBe('/apple');
  });

  it('accepts site paths and http(s) URLs only', () => {
    expect(normalizeTo('/new?x=1#y')).toBe('/new?x=1#y');
    expect(normalizeTo('https://example.com/a')).toBe('https://example.com/a');
    for (const bad of [
      '',
      'new',
      '//evil.example',
      '/\\evil',
      'javascript:alert(1)',
      'ftp://x.y',
      '/a b',
      '/a\nb',
      7,
    ]) {
      expect(() => normalizeTo(bad), String(bad)).toThrow(RedirectValidationError);
    }
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿from,to\r\n"/a,b","/c ""d"""\n\n/x,/y')).toEqual([
      ['from', 'to'],
      ['/a,b', '/c "d"'],
      ['/x', '/y'],
    ]);
    expect(() => parseCsv('"open')).toThrow(RedirectValidationError);
  });
});

describe('RedirectsService', () => {
  it('creates, lists, updates and deletes rules, keeping them out of autoload', async () => {
    const { redirects, store } = setup();
    const a = await redirects.create({ from: '/old', to: '/new' });
    const b = await redirects.create({ from: '/temp/', to: 'https://example.com', status: 302 });
    expect(a).toEqual({ id: 1, from: '/old', to: '/new', status: 301 });
    expect(b).toMatchObject({ id: 2, from: '/temp', status: 302 });
    expect(await redirects.list()).toHaveLength(2);
    expect(store.rows.get('redirects')?.autoload).toBe(false);
    expect(await redirects.update(1, { to: '/newer', status: 302 })).toEqual({
      id: 1,
      from: '/old',
      to: '/newer',
      status: 302,
    });
    await redirects.delete(1);
    expect(await redirects.get(1)).toBeUndefined();
    await expect(redirects.delete(1)).rejects.toBeInstanceOf(RedirectNotFoundError);
    await expect(redirects.update(99, { to: '/x' })).rejects.toBeInstanceOf(RedirectNotFoundError);
    // Ids are not reused.
    expect((await redirects.create({ from: '/again', to: '/z' })).id).toBe(3);
  });

  it('refuses a duplicate old path and a bad status', async () => {
    const { redirects } = setup();
    await redirects.create({ from: '/old', to: '/new' });
    await expect(redirects.create({ from: '/old/', to: '/other' })).rejects.toThrow(/already/);
    await expect(redirects.create({ from: '/b', to: '/c', status: 307 })).rejects.toMatchObject({
      field: 'status',
    });
    const second = await redirects.create({ from: '/b', to: '/c' });
    await expect(redirects.update(second.id, { from: '/old' })).rejects.toThrow(/already/);
  });

  it('refuses loops, direct and through other rules', async () => {
    const { redirects } = setup();
    await expect(redirects.create({ from: '/a', to: '/a' })).rejects.toThrow(/loop/);
    await redirects.create({ from: '/a', to: '/b' });
    await redirects.create({ from: '/b', to: '/c' });
    await expect(redirects.create({ from: '/c', to: '/a' })).rejects.toThrow(/loop/);
    // A different site, or a path with no further rule, is fine.
    await redirects.create({ from: '/c', to: 'https://example.com/a' });
  });

  it('matches exact paths ignoring a trailing slash, and the longest wildcard', async () => {
    const { redirects } = setup();
    await redirects.create({ from: '/old', to: '/new' });
    await redirects.create({ from: '/blog/*', to: '/news/*' });
    await redirects.create({ from: '/blog/archive/*', to: '/archive', status: 302 });
    await redirects.create({ from: '/blog/special', to: '/special' });
    expect(await redirects.match('/old')).toEqual({ to: '/new', status: 301 });
    expect(await redirects.match('/old/')).toEqual({ to: '/new', status: 301 });
    expect(await redirects.match('/blog/post-1')).toEqual({ to: '/news/post-1', status: 301 });
    expect(await redirects.match('/blog/archive/2020')).toEqual({ to: '/archive', status: 302 });
    expect(await redirects.match('/blog/special')).toEqual({ to: '/special', status: 301 });
    expect(await redirects.match('/other')).toBeUndefined();
    expect(await redirects.match('/')).toBeUndefined();
  });

  it('never lets a wildcard turn a site path into another site', async () => {
    const { redirects } = setup();
    await redirects.create({ from: '/go/*', to: '/*' });
    expect(await redirects.match('/go/news')).toEqual({ to: '/news', status: 301 });
    expect(await redirects.match('/go//evil.example')).toBeUndefined();
    expect(await redirects.match('/go/\\evil.example')).toBeUndefined();
  });

  it('a "*" in the target needs a wildcard rule', async () => {
    const { redirects } = setup();
    await expect(redirects.create({ from: '/a', to: '/b/*' })).rejects.toMatchObject({
      field: 'to',
    });
  });

  it('imports CSV: header skipped, status optional, existing rules replaced, bad rows reported', async () => {
    const { redirects } = setup();
    await redirects.create({ from: '/old', to: '/stale' });
    const report = await redirects.importCsv(
      [
        'from,to,status',
        '/old,/fresh,302',
        '/a,/b',
        '"/c","https://example.com/c",301',
        'nope,/x',
        '/d,/e,999',
        '/f',
        '',
        '/g,/g',
        '/h,/i,302,extra',
      ].join('\n'),
    );
    expect(report.created).toBe(2);
    expect(report.updated).toBe(1);
    expect(report.errors.map((e) => e.line)).toEqual([5, 6, 7, 9, 10]);
    expect(await redirects.match('/old')).toEqual({ to: '/fresh', status: 302 });
    expect(await redirects.match('/c')).toEqual({ to: 'https://example.com/c', status: 301 });
    expect(await redirects.match('/d')).toBeUndefined();
  });

  it('import catches loops among the imported rows and changes nothing when all rows fail', async () => {
    const { redirects, store } = setup();
    const report = await redirects.importCsv('/a,/b\n/b,/a\n');
    expect(report.created).toBe(1);
    expect(report.errors).toEqual([{ line: 2, message: expect.stringContaining('loop') }]);
    const none = setup();
    expect((await none.redirects.importCsv('bad,row\n')).errors).toHaveLength(1);
    expect(none.store.rows.has('redirects')).toBe(false);
    expect(store.rows.has('redirects')).toBe(true);
  });

  it('rejects a malformed or oversized file and limits the number of rules', async () => {
    const { redirects } = setup();
    await expect(redirects.importCsv('"unclosed')).rejects.toBeInstanceOf(RedirectValidationError);
    await expect(redirects.importCsv('x'.repeat(1024 * 1024 + 1))).rejects.toMatchObject({
      field: 'csv',
    });
    expect(MAX_REDIRECTS).toBe(5000);
  });

  it('addMany keeps new rules, leaves existing ones alone and reports the rest', async () => {
    const { redirects } = setup();
    await redirects.create({ from: '/mine', to: '/owner-choice' });
    const result = await redirects.addMany([
      { from: '/a', to: '/b' },
      { from: '/mine', to: '/imported' },
      { from: 'bad', to: '/x' },
      { from: '/b', to: '/a' },
    ]);
    expect(result.created).toBe(1);
    expect(result.skipped.map((s) => s.from)).toEqual(['/mine', 'bad', '/b']);
    expect(await redirects.match('/mine')).toEqual({ to: '/owner-choice', status: 301 });
    expect(await redirects.match('/a')).toEqual({ to: '/b', status: 301 });
    expect(await redirects.addMany([])).toEqual({ created: 0, skipped: [] });
  });

  it('serialises concurrent writes', async () => {
    const { redirects } = setup();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => redirects.create({ from: `/p${i}`, to: `/q${i}` })),
    );
    const list = await redirects.list();
    expect(list).toHaveLength(10);
    expect(new Set(list.map((r) => r.id)).size).toBe(10);
  });
});
