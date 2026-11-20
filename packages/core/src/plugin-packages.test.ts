import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PluginPackageError,
  PluginStateService,
  discoverPlugins,
  loadPluginDefinition,
  loadPluginPackages,
  parsePluginManifest,
  runPluginMigrations,
  splitStatements,
  type DiscoveredPlugin,
  type PluginRow,
  type PluginsStore,
  type SqlRunner,
} from './plugin-packages.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'np-plugins-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function memoryStore(): PluginsStore & { rows: Map<string, PluginRow> } {
  const rows = new Map<string, PluginRow>();
  return {
    rows,
    async list() {
      return [...rows.values()];
    },
    async get(name) {
      return rows.get(name);
    },
    async upsert(row) {
      rows.set(row.name, { ...row });
    },
  };
}

function memoryOptions() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (async (key: string) => values.get(key)) as never,
    set: (async (key: string, value: unknown) => {
      values.set(key, value);
    }) as never,
  } as {
    values: Map<string, unknown>;
    get: Parameters<typeof runPluginMigrations>[0]['options']['get'];
    set: Parameters<typeof runPluginMigrations>[0]['options']['set'];
  };
}

function fakeRunner(dialect: 'sqlite' | 'postgres' = 'sqlite', failOn?: string) {
  const statements: string[] = [];
  const runner: SqlRunner = {
    dialect,
    async run(statement) {
      if (failOn && statement.includes(failOn)) throw new Error('boom');
      statements.push(statement);
    },
  };
  return { runner, statements };
}

async function writePlugin(
  name: string,
  manifest: Record<string, unknown> = {},
  files: Record<string, string> = { 'index.js': 'export default {}' },
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(dir, file, '..'), { recursive: true });
    await writeFile(join(dir, file), content);
  }
  return dir;
}

describe('parsePluginManifest', () => {
  it('accepts a minimal manifest and fills defaults', () => {
    expect(parsePluginManifest({ name: 'notes', version: '1.2.3' })).toEqual({
      name: 'notes',
      version: '1.2.3',
      title: 'notes',
      permissions: [],
      entry: 'index.js',
    });
  });

  it('keeps title, description, entry and de-duplicates permissions', () => {
    const manifest = parsePluginManifest({
      name: 'notes',
      version: '1.0.0',
      title: ' Notes ',
      description: 'Sticky notes',
      entry: 'dist/main.mjs',
      permissions: ['content:read', 'content:read', 'database'],
    });
    expect(manifest.title).toBe('Notes');
    expect(manifest.description).toBe('Sticky notes');
    expect(manifest.entry).toBe('dist/main.mjs');
    expect(manifest.permissions).toEqual(['content:read', 'database']);
  });

  it.each<[unknown, RegExp]>([
    [null, /object/],
    [{ name: 'Bad Name', version: '1.0.0' }, /name/],
    [{ name: 'core', version: '1.0.0' }, /name/],
    [{ name: 'a', version: '1' }, /version/],
    [{ name: 'a', version: '1.0.0', title: '' }, /title/],
    [{ name: 'a', version: '1.0.0', permissions: 'all' }, /permissions/],
    [{ name: 'a', version: '1.0.0', permissions: ['root'] }, /unknown permission/],
    [{ name: 'a', version: '1.0.0', entry: '../x.js' }, /entry/],
    [{ name: 'a', version: '1.0.0', entry: '/etc/x.js' }, /entry/],
    [{ name: 'a', version: '1.0.0', entry: 'index.ts' }, /entry/],
  ])('rejects %j', (raw, message) => {
    expect(() => parsePluginManifest(raw)).toThrow(message);
  });
});

describe('discoverPlugins', () => {
  it('returns nothing when the folder does not exist', async () => {
    expect(await discoverPlugins(join(root, 'missing'))).toEqual({ plugins: [], errors: [] });
  });

  it('finds packages, ignores other folders and reports broken ones without stopping', async () => {
    await writePlugin('alpha');
    await writePlugin('beta', {}, { 'index.js': '' });
    await mkdir(join(root, 'not-a-plugin'));
    await mkdir(join(root, '.hidden'));
    await writePlugin('wrong-folder', { name: 'other' });
    await writePlugin('no-entry', {}, {});
    await mkdir(join(root, 'bad-json'));
    await writeFile(join(root, 'bad-json', 'plugin.json'), '{nope');

    const { plugins, errors } = await discoverPlugins(root);
    expect(plugins.map((p) => p.manifest.name)).toEqual(['alpha', 'beta']);
    expect(plugins[0]?.hasMigrations).toBe(false);
    expect(errors.map((e) => e.dir).sort()).toEqual(['bad-json', 'no-entry', 'wrong-folder']);
    expect(errors.find((e) => e.dir === 'wrong-folder')?.message).toMatch(/folder/);
    expect(errors.find((e) => e.dir === 'no-entry')?.message).toMatch(/does not exist/);
    expect(errors.find((e) => e.dir === 'bad-json')?.message).toMatch(/JSON/);
  });

  it('rejects an entry that links outside the plugin folder', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'np-outside-'));
    try {
      await writeFile(join(outside, 'evil.js'), 'export default {}');
      const dir = await writePlugin('linked', {}, {});
      await symlink(join(outside, 'evil.js'), join(dir, 'index.js'));
      const { plugins, errors } = await discoverPlugins(root);
      expect(plugins).toEqual([]);
      expect(errors[0]?.message).toMatch(/inside the plugin folder/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('requires the database permission for a migrations folder', async () => {
    await writePlugin('needs-db', {}, { 'index.js': '', 'migrations/sqlite/0001_a.sql': 'select 1' });
    await writePlugin(
      'has-db',
      { permissions: ['database'] },
      { 'index.js': '', 'migrations/sqlite/0001_a.sql': 'select 1' },
    );
    const { plugins, errors } = await discoverPlugins(root);
    expect(plugins.map((p) => [p.manifest.name, p.hasMigrations])).toEqual([['has-db', true]]);
    expect(errors[0]?.message).toMatch(/database/);
  });
});

describe('loadPluginDefinition', () => {
  const plugin = (name = 'demo'): DiscoveredPlugin => ({
    manifest: { name, version: '1.0.0', title: name, permissions: [], entry: 'index.js' },
    dir: root,
    entryFile: join(root, 'index.js'),
    hasMigrations: false,
  });
  const definition = { name: 'demo', setup: () => undefined };

  it('accepts a default export or a named plugin export', async () => {
    expect(await loadPluginDefinition(plugin(), async () => ({ default: definition }))).toBe(definition);
    expect(await loadPluginDefinition(plugin(), async () => ({ plugin: definition }))).toBe(definition);
  });

  it('rejects modules that are not plugins', async () => {
    await expect(loadPluginDefinition(plugin(), async () => ({}))).rejects.toThrow(PluginPackageError);
    await expect(
      loadPluginDefinition(plugin(), async () => ({ default: { name: 'demo' } })),
    ).rejects.toThrow(/default export/);
  });

  it('rejects a name that differs from plugin.json', async () => {
    await expect(
      loadPluginDefinition(plugin('other'), async () => ({ default: definition })),
    ).rejects.toThrow(/named "demo"/);
  });

  it('wraps import failures', async () => {
    await expect(
      loadPluginDefinition(plugin(), async () => {
        throw new Error('syntax');
      }),
    ).rejects.toThrow(/could not load index.js: syntax/);
  });
});

describe('PluginStateService', () => {
  it('starts with nothing enabled', async () => {
    const state = new PluginStateService(memoryStore());
    expect(await state.enabled()).toEqual([]);
    expect(await state.isEnabled('notes')).toBe(false);
  });

  it('turns plugins on and off and keeps the version', async () => {
    const store = memoryStore();
    const state = new PluginStateService(store);
    expect(await state.setEnabled('notes', true, '1.0.0')).toEqual(['notes']);
    expect(await state.setEnabled('forms', true, '2.0.0')).toEqual(['notes', 'forms']);
    expect(await state.setEnabled('notes', false, '1.1.0')).toEqual(['forms']);
    expect(store.rows.get('notes')).toEqual({ name: 'notes', version: '1.1.0', enabled: false });
    expect(await new PluginStateService(store).isEnabled('forms')).toBe(true);
  });

  it('validates names and versions and serializes concurrent changes', async () => {
    const state = new PluginStateService(memoryStore());
    await expect(state.setEnabled('Bad', true, '1.0.0')).rejects.toThrow(PluginPackageError);
    await expect(state.setEnabled('ok', true, 'x')).rejects.toThrow(/version/);
    await Promise.all([
      state.setEnabled('a', true, '1.0.0'),
      state.setEnabled('b', true, '1.0.0'),
      state.setEnabled('c', true, '1.0.0'),
    ]);
    expect((await state.enabled()).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('splitStatements', () => {
  it('splits on statement-breakpoint lines and drops empties', () => {
    expect(
      splitStatements('create table a (id int);\n-- statement-breakpoint\n\ncreate table b (id int);\n--statement-breakpoint\n'),
    ).toEqual(['create table a (id int);', 'create table b (id int);']);
  });
});

describe('runPluginMigrations', () => {
  async function migratingPlugin(files: Record<string, string>): Promise<DiscoveredPlugin> {
    const all: Record<string, string> = { 'index.js': '' };
    for (const [file, content] of Object.entries(files)) all[`migrations/${file}`] = content;
    await writePlugin('notes', { permissions: ['database'] }, all);
    const found = await discoverPlugins(root);
    const plugin = found.plugins[0];
    if (!plugin) throw new Error(JSON.stringify(found.errors));
    return plugin;
  }

  it('runs pending files in order, once, per dialect', async () => {
    const plugin = await migratingPlugin({
      'sqlite/0002_b.sql': 'create table b (id integer)',
      'sqlite/0001_a.sql': 'create table a (id integer);\n-- statement-breakpoint\ncreate index a_i on a (id)',
      'postgres/0001_a.sql': 'create table pg_a (id int)',
      'sqlite/README.md': 'ignored',
    });
    const options = memoryOptions();
    const sqlite = fakeRunner('sqlite');
    expect(await runPluginMigrations({ plugin, runner: sqlite.runner, options })).toEqual([
      '0001_a.sql',
      '0002_b.sql',
    ]);
    expect(sqlite.statements).toEqual([
      'create table a (id integer);',
      'create index a_i on a (id)',
      'create table b (id integer)',
    ]);
    expect(options.values.get('plugin_migrations')).toEqual({
      notes: ['0001_a.sql', '0002_b.sql'],
    });

    const again = fakeRunner('sqlite');
    expect(await runPluginMigrations({ plugin, runner: again.runner, options })).toEqual([]);
    expect(again.statements).toEqual([]);

    const pg = fakeRunner('postgres');
    expect(await runPluginMigrations({ plugin, runner: pg.runner, options: memoryOptions() })).toEqual([
      '0001_a.sql',
    ]);
    expect(pg.statements).toEqual(['create table pg_a (id int)']);
  });

  it('stops at a failing file, keeps earlier ones recorded and retries the failed one later', async () => {
    const plugin = await migratingPlugin({
      'sqlite/0001_a.sql': 'create table a (id integer)',
      'sqlite/0002_bad.sql': 'create table bad (id integer)',
      'sqlite/0003_c.sql': 'create table c (id integer)',
    });
    const options = memoryOptions();
    const failing = fakeRunner('sqlite', 'bad');
    await expect(
      runPluginMigrations({ plugin, runner: failing.runner, options }),
    ).rejects.toThrow(/0002_bad.sql failed: boom/);
    expect(options.values.get('plugin_migrations')).toEqual({ notes: ['0001_a.sql'] });
    expect(failing.statements).toEqual(['create table a (id integer)']);

    const ok = fakeRunner('sqlite');
    expect(await runPluginMigrations({ plugin, runner: ok.runner, options })).toEqual([
      '0002_bad.sql',
      '0003_c.sql',
    ]);
  });

  it('does nothing without a migrations folder or for a dialect with no folder', async () => {
    await writePlugin('plain');
    const plain = (await discoverPlugins(root)).plugins[0]!;
    const { runner } = fakeRunner();
    expect(await runPluginMigrations({ plugin: plain, runner, options: memoryOptions() })).toEqual([]);
    const plugin = await migratingPlugin({ 'postgres/0001_a.sql': 'select 1' });
    expect(await runPluginMigrations({ plugin, runner, options: memoryOptions() })).toEqual([]);
  });

  it('refuses without the database permission', async () => {
    const plugin = await migratingPlugin({ 'sqlite/0001_a.sql': 'select 1' });
    const noPermission: DiscoveredPlugin = {
      ...plugin,
      manifest: { ...plugin.manifest, permissions: [] },
    };
    await expect(
      runPluginMigrations({ plugin: noPermission, runner: fakeRunner().runner, options: memoryOptions() }),
    ).rejects.toThrow(/database/);
  });
});

describe('loadPluginPackages', () => {
  const importer = async (file: string) => ({
    default: {
      name: file.split('/').slice(-2, -1)[0],
      setup: () => undefined,
    },
  });

  function setup() {
    const registered: string[] = [];
    const logs: string[] = [];
    const logger = {
      debug: () => undefined,
      info: (m: string) => void logs.push(`info:${m}`),
      warn: (m: string) => void logs.push(`warn:${m}`),
      error: (m: string) => void logs.push(`error:${m}`),
    };
    return {
      registered,
      logs,
      logger: logger as never,
      plugins: { register: (def: { name: string }) => void registered.push(def.name) } as never,
    };
  }

  it('registers enabled packages only and leaves new ones off', async () => {
    await writePlugin('alpha');
    await writePlugin('beta');
    const state = new PluginStateService(memoryStore());
    await state.setEnabled('alpha', true, '1.0.0');
    const s = setup();
    const result = await loadPluginPackages({
      dir: root,
      state,
      plugins: s.plugins,
      options: memoryOptions(),
      logger: s.logger,
      importer,
    });
    expect(result).toEqual({ registered: ['alpha'], disabled: ['beta'], failed: [] });
    expect(s.registered).toEqual(['alpha']);
  });

  it('applies migrations before registering, and isolates failures', async () => {
    await writePlugin(
      'with-db',
      { permissions: ['database'] },
      { 'index.js': '', 'migrations/sqlite/0001_a.sql': 'create table t (id integer)' },
    );
    await writePlugin(
      'broken-db',
      { permissions: ['database'] },
      { 'index.js': '', 'migrations/sqlite/0001_a.sql': 'explode' },
    );
    await writePlugin('fine');
    await writePlugin('wrong-folder', { name: 'other' });
    const state = new PluginStateService(memoryStore());
    for (const name of ['with-db', 'broken-db', 'fine']) await state.setEnabled(name, true, '1.0.0');
    const s = setup();
    const { runner, statements } = fakeRunner('sqlite', 'explode');
    const result = await loadPluginPackages({
      dir: root,
      state,
      plugins: s.plugins,
      options: memoryOptions(),
      runner,
      logger: s.logger,
      importer,
    });
    expect(result.registered).toEqual(['fine', 'with-db']);
    expect(statements).toEqual(['create table t (id integer)']);
    expect(result.failed.map((f) => f.name).sort()).toEqual(['broken-db', 'wrong-folder']);
    expect(s.logs.some((l) => l.startsWith('error:Plugin "broken-db"'))).toBe(true);
    expect(s.logs.some((l) => l.startsWith('warn:Plugin "wrong-folder"'))).toBe(true);
  });

  it('skips a package that has migrations when there is no runner', async () => {
    await writePlugin(
      'with-db',
      { permissions: ['database'] },
      { 'index.js': '', 'migrations/sqlite/0001_a.sql': 'select 1' },
    );
    const state = new PluginStateService(memoryStore());
    await state.setEnabled('with-db', true, '1.0.0');
    const s = setup();
    const result = await loadPluginPackages({
      dir: root,
      state,
      plugins: s.plugins,
      options: memoryOptions(),
      logger: s.logger,
      importer,
    });
    expect(result.registered).toEqual([]);
    expect(result.failed[0]?.message).toMatch(/no database/);
  });

  it('imports a real module from disk with the default importer', async () => {
    await writePlugin(
      'real',
      {},
      { 'index.js': "export default { name: 'real', setup() {} };\n" },
    );
    const state = new PluginStateService(memoryStore());
    await state.setEnabled('real', true, '1.0.0');
    const s = setup();
    const result = await loadPluginPackages({
      dir: root,
      state,
      plugins: s.plugins,
      options: memoryOptions(),
      logger: s.logger,
    });
    expect(result.registered).toEqual(['real']);
  });
});
