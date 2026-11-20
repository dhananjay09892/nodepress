import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import type { Logger } from './logger.js';
import {
  ThemeError,
  ThemeService,
  discoverThemes,
  parseThemeManifest,
  templateHierarchy,
  type Theme,
} from './themes.js';

describe('parseThemeManifest', () => {
  it('accepts a minimal manifest and fills in defaults', () => {
    expect(parseThemeManifest({ name: 'aurora', version: '1.0.0' })).toEqual({
      name: 'aurora',
      version: '1.0.0',
      title: 'aurora',
      supports: [],
      settings: {},
      templates: 'templates',
      assets: 'assets',
    });
  });

  it('keeps the optional fields and removes duplicate features', () => {
    const manifest = parseThemeManifest({
      name: 'my-theme',
      version: '2.1.0-beta.1',
      title: ' My Theme ',
      description: 'Nice',
      supports: ['dark-mode', 'menus', 'menus'],
      settings: { accent: { type: 'color' } },
      templates: 'dist/templates',
      assets: 'public',
    });
    expect(manifest.title).toBe('My Theme');
    expect(manifest.supports).toEqual(['dark-mode', 'menus']);
    expect(manifest.templates).toBe('dist/templates');
    expect(manifest.settings).toEqual({ accent: { type: 'color' } });
  });

  it.each([
    [null, 'object'],
    [[], 'object'],
    [{ version: '1.0.0' }, '"name"'],
    [{ name: 'Bad Name', version: '1.0.0' }, '"name"'],
    [{ name: '../x', version: '1.0.0' }, '"name"'],
    [{ name: 'a', version: 'one' }, '"version"'],
    [{ name: 'a', version: '1.0.0', title: '' }, '"title"'],
    [{ name: 'a', version: '1.0.0', supports: 'menus' }, '"supports"'],
    [{ name: 'a', version: '1.0.0', supports: ['Not Valid'] }, '"supports"'],
    [{ name: 'a', version: '1.0.0', settings: [] }, '"settings"'],
    [{ name: 'a', version: '1.0.0', templates: '../outside' }, '"templates"'],
    [{ name: 'a', version: '1.0.0', assets: '/etc' }, '"assets"'],
  ])('rejects %j', (raw: unknown, fragment: string) => {
    expect(() => parseThemeManifest(raw)).toThrow(ThemeError);
    expect(() => parseThemeManifest(raw)).toThrow(fragment);
  });
});

describe('templateHierarchy', () => {
  it('puts a custom type through single-{type}, single, index', () => {
    expect(templateHierarchy({ kind: 'single', type: 'product', slug: 'mug' })).toEqual([
      'single-product',
      'single',
      'index',
    ]);
    expect(templateHierarchy({ kind: 'single', type: 'post', slug: 'hello' })).toEqual([
      'single-post',
      'single',
      'index',
    ]);
  });

  it('tries page-{slug} first for pages', () => {
    expect(templateHierarchy({ kind: 'single', type: 'page', slug: 'about-us' })).toEqual([
      'page-about-us',
      'page',
      'single',
      'index',
    ]);
  });

  it('covers archive, front page and not found', () => {
    expect(templateHierarchy({ kind: 'archive', type: 'post' })).toEqual([
      'archive-post',
      'archive',
      'index',
    ]);
    expect(templateHierarchy({ kind: 'front' })).toEqual(['front', 'index']);
    expect(templateHierarchy({ kind: 'not_found' })).toEqual(['404', 'index']);
  });

  it('leaves out names that are not valid template names', () => {
    expect(templateHierarchy({ kind: 'single', type: '../etc/passwd', slug: 'x' })).toEqual([
      'single',
      'index',
    ]);
    expect(templateHierarchy({ kind: 'single', type: 'page', slug: 'A/B' })).toEqual([
      'page',
      'single',
      'index',
    ]);
  });
});

describe('discoverThemes', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'np-themes-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeTheme(name: string, manifest: unknown, files: string[] = []): Promise<void> {
    const dir = join(root, name);
    await mkdir(join(dir, 'templates'), { recursive: true });
    await writeFile(
      join(dir, 'theme.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
    for (const file of files) await writeFile(join(dir, 'templates', file), '');
  }

  it('finds themes and their templates, preferring compiled files', async () => {
    await makeTheme('aurora', { name: 'aurora', version: '1.0.0' }, [
      'index.tsx',
      'index.js',
      'single-product.tsx',
      'page-about.mjs',
      'notes.txt',
      'Bad_Name.js',
    ]);
    const { themes, errors } = await discoverThemes(root);
    expect(errors).toEqual([]);
    expect(themes).toHaveLength(1);
    const theme = themes[0]!;
    expect(theme.dir).toBe(join(root, 'aurora'));
    expect(theme.assetsDir).toBe(join(root, 'aurora', 'assets'));
    expect(theme.templates).toEqual({
      index: join(root, 'aurora', 'templates', 'index.js'),
      'single-product': join(root, 'aurora', 'templates', 'single-product.tsx'),
      'page-about': join(root, 'aurora', 'templates', 'page-about.mjs'),
    });
  });

  it('reports broken themes and keeps loading the others', async () => {
    await makeTheme('good', { name: 'good', version: '1.0.0' });
    await makeTheme('bad-json', '{ nope');
    await makeTheme('bad-fields', { name: 'bad-fields', version: 'x' });
    await makeTheme('moved', { name: 'other', version: '1.0.0' });
    await makeTheme(
      'huge',
      JSON.stringify({ name: 'huge', version: '1.0.0', pad: 'x'.repeat(70_000) }),
    );
    const { themes, errors } = await discoverThemes(root);
    expect(themes.map((t) => t.manifest.name)).toEqual(['good']);
    expect(Object.fromEntries(errors.map((e) => [e.dir, e.message]))).toEqual({
      'bad-fields': '"version" must look like 1.2.3',
      'bad-json': 'theme.json is not valid JSON',
      huge: 'theme.json is too large',
      moved: '"name" is "other" but the folder is "moved"',
    });
  });

  it('ignores folders without a manifest, hidden folders and files', async () => {
    await mkdir(join(root, 'plain'));
    await makeTheme('.hidden', { name: 'hidden', version: '1.0.0' });
    await writeFile(join(root, 'readme.txt'), 'hi');
    expect(await discoverThemes(root)).toEqual({ themes: [], errors: [] });
  });

  it('follows symlinked theme folders (workspace links)', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'np-theme-src-'));
    try {
      await writeFile(
        join(elsewhere, 'theme.json'),
        JSON.stringify({ name: 'linked', version: '1.0.0' }),
      );
      await symlink(elsewhere, join(root, 'linked'));
      const { themes } = await discoverThemes(root);
      expect(themes.map((t) => t.manifest.name)).toEqual(['linked']);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('returns nothing when the folder does not exist', async () => {
    expect(await discoverThemes(join(root, 'missing'))).toEqual({ themes: [], errors: [] });
  });
});

function fakeTheme(name: string, templates: string[]): Theme {
  return {
    manifest: parseThemeManifest({ name, version: '1.0.0' }),
    dir: `/themes/${name}`,
    assetsDir: `/themes/${name}/assets`,
    templates: Object.fromEntries(templates.map((t) => [t, `/themes/${name}/templates/${t}.js`])),
  };
}

describe('ThemeService', () => {
  function setup(modules: Record<string, unknown>, templates?: string[]) {
    const hooks = new HookRegistry();
    const imported: string[] = [];
    const warnings: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      error() {},
      warn: (message) => void warnings.push(message),
      child: () => logger,
    };
    const service = new ThemeService({
      hooks,
      logger,
      importer: async (file) => {
        imported.push(file);
        const module = modules[file];
        if (module instanceof Error) throw module;
        return module;
      },
    });
    service.register([
      fakeTheme(
        'demo',
        templates ?? Object.keys(modules).map((f) => f.split('/').pop()!.replace('.js', '')),
      ),
    ]);
    service.activate('demo');
    return { hooks, service, imported, warnings };
  }

  const file = (name: string) => `/themes/demo/templates/${name}.js`;
  const component = () => 'x';

  it('picks the most specific template that exists', async () => {
    const { service } = setup({
      [file('index')]: { default: component },
      [file('single')]: { default: component },
      [file('single-product')]: { default: component },
    });
    expect((await service.resolve({ kind: 'single', type: 'product', slug: 'mug' }))?.name).toBe(
      'single-product',
    );
    expect((await service.resolve({ kind: 'single', type: 'post', slug: 'a' }))?.name).toBe(
      'single',
    );
    expect((await service.resolve({ kind: 'not_found' }))?.name).toBe('index');
  });

  it('returns undefined without an active theme or a matching template', async () => {
    const hooks = new HookRegistry();
    const service = new ThemeService({ hooks, importer: async () => ({ default: component }) });
    expect(await service.resolve({ kind: 'front' })).toBeUndefined();
    service.register([fakeTheme('demo', ['single'])]);
    expect(service.activate('missing')).toBe(false);
    expect(service.activate('demo')).toBe(true);
    expect(await service.resolve({ kind: 'not_found' })).toBeUndefined();
  });

  it('lets plugins change the candidates with the template:resolve filter', async () => {
    const { service, hooks } = setup({
      [file('index')]: { default: component },
      [file('landing')]: { default: component },
    });
    hooks.addFilter('template:resolve', (names, { target }) =>
      target.kind === 'single' && target.slug === 'sale' ? ['landing', ...names] : names,
    );
    expect((await service.resolve({ kind: 'single', type: 'page', slug: 'sale' }))?.name).toBe(
      'landing',
    );
    expect((await service.resolve({ kind: 'single', type: 'page', slug: 'other' }))?.name).toBe(
      'index',
    );
  });

  it('ignores invalid names a plugin adds, so no path can be built from them', async () => {
    const { service, hooks, imported } = setup({ [file('index')]: { default: component } });
    hooks.addFilter('template:resolve', (names) => ['../../etc/passwd', 'A B', ...names]);
    expect((await service.resolve({ kind: 'front' }))?.name).toBe('index');
    expect(imported).toEqual([file('index')]);
  });

  it('skips a template that fails to load and falls back to a less specific one', async () => {
    const { service, warnings } = setup({
      [file('single')]: new Error('syntax error'),
      [file('index')]: { default: component },
    });
    const found = await service.resolve({ kind: 'single', type: 'post', slug: 'a' });
    expect(found?.name).toBe('index');
    expect(warnings.join('\n')).toContain('"single" could not be loaded');
  });

  it('skips a template without a default function export', async () => {
    const { service, warnings } = setup({ [file('index')]: { default: 'nope' } });
    expect(await service.resolve({ kind: 'front' })).toBeUndefined();
    expect(warnings.join('\n')).toContain('no default export');
  });

  it('imports each template once', async () => {
    const { service, imported } = setup({ [file('index')]: { default: component } });
    await service.resolve({ kind: 'front' });
    await service.resolve({ kind: 'front' });
    expect(imported).toEqual([file('index')]);
  });
});
