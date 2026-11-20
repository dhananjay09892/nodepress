import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanIncomingFolders, installPluginZip, listPluginPackages } from './plugin-install.js';
import { PluginPackageError, PluginStateService, type PluginRow } from './plugin-packages.js';
import { createTestZip } from './testing/zip-builder.js';

let dir: string;
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'np-install-')), 'plugins');
});
afterEach(async () => {
  await rm(join(dir, '..'), { recursive: true, force: true });
});

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'notes', version: '1.0.0', permissions: ['content:read'], ...extra });

function memoryState(): PluginStateService {
  const rows = new Map<string, PluginRow>();
  return new PluginStateService({
    async list() {
      return [...rows.values()];
    },
    async get(name) {
      return rows.get(name);
    },
    async upsert(row) {
      rows.set(row.name, row);
    },
  });
}

describe('installPluginZip', () => {
  it('installs a package into <dir>/<name> and leaves no scratch folder', async () => {
    const zip = createTestZip([
      { name: 'plugin.json', data: manifest() },
      { name: 'index.js', data: 'export default {}' },
      { name: 'lib/util.js', data: 'export {}' },
    ]);
    const plugin = await installPluginZip({ dir, zip });
    expect(plugin.manifest.name).toBe('notes');
    expect(plugin.dir).toBe(join(dir, 'notes'));
    expect(await readFile(join(dir, 'notes', 'lib', 'util.js'), 'utf8')).toBe('export {}');
    expect(await readdir(dir)).toEqual(['notes']);
  });

  it('accepts a zip made of a folder (one top-level folder)', async () => {
    const zip = createTestZip([
      { name: 'notes-1.0/plugin.json', data: manifest() },
      { name: 'notes-1.0/index.js', data: 'export default {}' },
    ]);
    await installPluginZip({ dir, zip });
    expect((await stat(join(dir, 'notes', 'index.js'))).isFile()).toBe(true);
  });

  it('never overwrites an installed plugin', async () => {
    const zip = createTestZip([
      { name: 'plugin.json', data: manifest() },
      { name: 'index.js', data: 'one' },
    ]);
    await installPluginZip({ dir, zip });
    await expect(installPluginZip({ dir, zip })).rejects.toThrow(/already installed/);
    expect(await readFile(join(dir, 'notes', 'index.js'), 'utf8')).toBe('one');
    expect(await readdir(dir)).toEqual(['notes']);
  });

  it.each([
    [
      'not a zip',
      () => new TextEncoder().encode('hello world, definitely not a zip file'),
      /not a usable zip/,
    ],
    ['no manifest', () => createTestZip([{ name: 'index.js', data: 'x' }]), /no plugin.json/],
    [
      'bad json',
      () =>
        createTestZip([
          { name: 'plugin.json', data: '{' },
          { name: 'index.js', data: 'x' },
        ]),
      /not valid JSON/,
    ],
    [
      'bad manifest',
      () => createTestZip([{ name: 'plugin.json', data: manifest({ name: 'Bad Name' }) }]),
      /name/,
    ],
    [
      'missing entry',
      () => createTestZip([{ name: 'plugin.json', data: manifest() }]),
      /does not exist/,
    ],
    [
      'migrations without permission',
      () =>
        createTestZip([
          { name: 'plugin.json', data: manifest() },
          { name: 'index.js', data: 'x' },
          { name: 'migrations/sqlite/0001_a.sql', data: 'select 1' },
        ]),
      /database/,
    ],
    [
      'path escape',
      () =>
        createTestZip([
          { name: 'plugin.json', data: manifest() },
          { name: '../escape.js', data: 'x' },
        ]),
      /unsafe/,
    ],
  ])('installs nothing for: %s', async (_label, build, message) => {
    await expect(installPluginZip({ dir, zip: build() })).rejects.toThrow(PluginPackageError);
    await expect(installPluginZip({ dir, zip: build() })).rejects.toThrow(message);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });
});

describe('listPluginPackages', () => {
  it('lists installed packages with their enabled state and running status', async () => {
    for (const name of ['alpha', 'beta']) {
      await installPluginZip({
        dir,
        zip: createTestZip([
          {
            name: 'plugin.json',
            data: manifest({ name, title: name.toUpperCase(), description: `${name} plugin` }),
          },
          { name: 'index.js', data: 'x' },
        ]),
      });
    }
    const state = memoryState();
    await state.setEnabled('beta', true, '1.0.0');
    const result = await listPluginPackages({
      dir,
      state,
      running: () => [
        { name: 'beta', version: '1.0.0', description: undefined, status: 'failed', error: 'boom' },
      ],
    });
    expect(result.broken).toEqual([]);
    expect(
      result.plugins.map((p) => [p.name, p.title, p.enabled, p.status, p.error, p.permissions]),
    ).toEqual([
      ['alpha', 'ALPHA', false, undefined, undefined, ['content:read']],
      ['beta', 'BETA', true, 'failed', 'boom', ['content:read']],
    ]);
  });

  it('reports broken folders without failing', async () => {
    await installPluginZip({
      dir,
      zip: createTestZip([
        { name: 'plugin.json', data: manifest() },
        { name: 'index.js', data: 'x' },
      ]),
    });
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'oops'));
    await writeFile(join(dir, 'oops', 'plugin.json'), '{');
    const result = await listPluginPackages({ dir, state: memoryState() });
    expect(result.plugins.map((p) => p.name)).toEqual(['notes']);
    expect(result.broken).toEqual([{ folder: 'oops', message: 'plugin.json is not valid JSON' }]);
  });
});

describe('cleanIncomingFolders', () => {
  it('removes leftovers of a crashed upload only', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, '.incoming-abc'), { recursive: true });
    await mkdir(join(dir, 'keep'));
    await cleanIncomingFolders(dir);
    expect(await readdir(dir)).toEqual(['keep']);
    await cleanIncomingFolders(join(dir, 'missing'));
  });
});
