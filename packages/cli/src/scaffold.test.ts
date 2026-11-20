import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageError } from './args.js';
import { scaffoldPlugin, scaffoldTheme, titleFromName } from './scaffold.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'np-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('titleFromName', () => {
  it('turns a kebab-case name into a title', () => {
    expect(titleFromName('reading-time')).toBe('Reading Time');
    expect(titleFromName('seo')).toBe('Seo');
  });
});

describe('scaffoldPlugin', () => {
  it('writes plugin.json, package.json, index.js and a README', async () => {
    const result = await scaffoldPlugin({ name: 'reading-time', dir });
    expect(result.root).toBe(join(dir, 'reading-time'));
    expect(result.files).toEqual(['plugin.json', 'package.json', 'index.js', 'README.md']);
    const manifest = JSON.parse(await readFile(join(result.root, 'plugin.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toEqual({
      name: 'reading-time',
      version: '0.1.0',
      title: 'Reading Time',
      description: 'The Reading Time plugin for NodePress.',
      permissions: [],
      entry: 'index.js',
    });
    const entry = await readFile(join(result.root, 'index.js'), 'utf8');
    expect(entry).toContain('name: "reading-time"');
    expect(entry).toContain("hooks.addAction('core:ready'");
  });

  it('uses the title and description it is given, safely quoted', async () => {
    const result = await scaffoldPlugin({
      name: 'quoted',
      dir,
      title: 'Say "hi"',
      description: 'Line\nbreak "and" quotes',
    });
    const entry = await readFile(join(result.root, 'index.js'), 'utf8');
    expect(entry).toContain('description: "Line\\nbreak \\"and\\" quotes"');
    expect(entry).toContain('"Say \\"hi\\" is ready"');
    const manifest = JSON.parse(await readFile(join(result.root, 'plugin.json'), 'utf8')) as {
      title: string;
    };
    expect(manifest.title).toBe('Say "hi"');
  });

  it.each(['Bad Name', 'UPPER', '-lead', 'trail-', 'a_b', 'core', '', 'x'.repeat(65)])(
    'rejects the name %j',
    async (name) => {
      await expect(scaffoldPlugin({ name, dir })).rejects.toThrow(UsageError);
      expect(await readdir(dir)).toEqual([]);
    },
  );

  it('does not write into a folder that has files unless forced', async () => {
    await scaffoldPlugin({ name: 'once', dir });
    await expect(scaffoldPlugin({ name: 'once', dir })).rejects.toThrow(/already has files/);
    await writeFile(join(dir, 'once', 'index.js'), 'changed');
    await scaffoldPlugin({ name: 'once', dir, force: true });
    expect(await readFile(join(dir, 'once', 'index.js'), 'utf8')).toContain('hooks.addAction');
  });
});

describe('scaffoldTheme', () => {
  it('writes a theme that mirrors the starter', async () => {
    const result = await scaffoldTheme({ name: 'my-theme', dir });
    expect(result.files).toEqual([
      'theme.json',
      'package.json',
      'tsconfig.json',
      'src/layout.tsx',
      'src/index.tsx',
      'assets/style.css',
      'README.md',
    ]);
    const manifest = JSON.parse(await readFile(join(result.root, 'theme.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      name: 'my-theme',
      version: '0.1.0',
      title: 'My Theme',
      templates: 'templates',
      assets: 'assets',
    });
    const tsconfig = JSON.parse(await readFile(join(result.root, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(tsconfig.compilerOptions).toMatchObject({
      outDir: 'templates',
      jsxImportSource: 'hono/jsx',
    });
    expect(await readFile(join(result.root, 'assets', 'style.css'), 'utf8')).toContain(
      '.np-my-theme',
    );
    expect(await readFile(join(result.root, 'src', 'index.tsx'), 'utf8')).toContain(
      "page.html ?? ''",
    );
  });

  it('validates the name and refuses an existing folder', async () => {
    await expect(scaffoldTheme({ name: 'Nope', dir })).rejects.toThrow(UsageError);
    await scaffoldTheme({ name: 'dup', dir });
    await expect(scaffoldTheme({ name: 'dup', dir })).rejects.toThrow(/already has files/);
  });
});
