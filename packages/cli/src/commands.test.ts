import { discoverPlugins, installPluginZip, readZip } from '@nodepress/core';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findServerMain, HELP, runCli, type CliIo } from './commands.js';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'np-cli-run-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function harness(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const started: Array<{ main: string; env: Record<string, string> }> = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    cwd,
    env,
    startServer: async (options) => {
      started.push(options);
      return 0;
    },
  };
  return { io, out, err, started, run: (...argv: string[]) => runCli(argv, io) };
}

describe('help and errors', () => {
  it('prints help for no command, help, -h and --help; and the version', async () => {
    for (const argv of [[], ['help'], ['-h'], ['plugin', '--help']]) {
      const h = harness();
      expect(await h.run(...argv)).toBe(0);
      expect(h.out.join('\n')).toBe(HELP);
    }
    const h = harness();
    expect(await h.run('--version')).toBe(0);
    expect(h.out).toEqual(['0.0.0']);
  });

  it('exits 2 with a hint for a usage mistake and 1 for a failure', async () => {
    const unknown = harness();
    expect(await unknown.run('frobnicate')).toBe(2);
    expect(unknown.err.join('\n')).toContain('Unknown command "frobnicate"');
    expect(unknown.err.join('\n')).toContain('nodepress --help');

    const missing = harness();
    expect(await missing.run('plugin', 'create')).toBe(2);
    expect(await harness().run('plugin')).toBe(2);
    expect(await harness().run('theme', 'build')).toBe(2);

    const failed = harness();
    expect(await failed.run('plugin', 'check', 'nowhere')).toBe(2);
  });
});

describe('plugin create, check and pack', () => {
  it('scaffolds a plugin that checks out, packs and installs through the server code', async () => {
    const h = harness();
    expect(await h.run('plugin', 'create', 'hello-cli', '--title', 'Hello CLI')).toBe(0);
    expect(h.out[0]).toContain('plugin.json, package.json, index.js, README.md');
    const folder = join(cwd, 'plugins-installed', 'hello-cli');

    const check = harness();
    expect(await check.run('plugin', 'check', folder)).toBe(0);
    expect(check.out).toEqual(['hello-cli 0.1.0 is a valid plugin.', 'Permissions: none']);

    const pack = harness();
    expect(await pack.run('plugin', 'pack', folder, '--out', join(cwd, 'out.zip'))).toBe(0);
    const zip = new Uint8Array(await readFile(join(cwd, 'out.zip')));
    expect(readZip(zip).map((f) => f.path)).toEqual([
      'README.md',
      'index.js',
      'package.json',
      'plugin.json',
    ]);

    // The packed file is exactly what the admin upload accepts.
    const site = join(cwd, 'site-plugins');
    const installed = await installPluginZip({ dir: site, zip });
    expect(installed.manifest.title).toBe('Hello CLI');
    expect((await discoverPlugins(site)).errors).toEqual([]);
  });

  it('checks the current folder by default and packs with the default file name', async () => {
    await harness().run('plugin', 'create', 'in-place', '--dir', cwd);
    const inside = { ...harness().io, cwd: join(cwd, 'in-place') };
    const out: string[] = [];
    inside.out = (line) => out.push(line);
    expect(await runCli(['plugin', 'check'], inside)).toBe(0);
    expect(await runCli(['plugin', 'pack'], inside)).toBe(0);
    expect(out.at(-2)).toBe('Wrote in-place-0.1.0.zip (4 files).');
    expect(
      readZip(new Uint8Array(await readFile(join(cwd, 'in-place', 'in-place-0.1.0.zip')))).length,
    ).toBe(4);
  });

  it('leaves node_modules, .git and old zips out of the package', async () => {
    await harness().run('plugin', 'create', 'tidy', '--dir', cwd);
    const folder = join(cwd, 'tidy');
    await mkdir(join(folder, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(folder, 'node_modules', 'x', 'i.js'), 'x');
    await mkdir(join(folder, '.git'));
    await writeFile(join(folder, '.git', 'HEAD'), 'x');
    await writeFile(join(folder, 'old.zip'), 'x');
    expect(await harness().run('plugin', 'pack', folder, '--out', join(cwd, 't.zip'))).toBe(0);
    const names = readZip(new Uint8Array(await readFile(join(cwd, 't.zip')))).map((f) => f.path);
    expect(names).toEqual(['README.md', 'index.js', 'package.json', 'plugin.json']);
  });

  it('refuses to create over an existing plugin, but --force allows it', async () => {
    await harness().run('plugin', 'create', 'dup');
    const again = harness();
    expect(await again.run('plugin', 'create', 'dup')).toBe(2);
    expect(again.err.join('\n')).toContain('already has files');
    expect(await harness().run('plugin', 'create', 'dup', '--force')).toBe(0);
  });

  it('reports a broken plugin with the reason and exit code 1', async () => {
    const folder = join(cwd, 'broken');
    await mkdir(folder);
    await writeFile(
      join(folder, 'plugin.json'),
      JSON.stringify({ name: 'broken', version: '1.0.0' }),
    );
    const h = harness();
    expect(await h.run('plugin', 'check', folder)).toBe(1);
    expect(h.err.join('\n')).toContain('does not exist');

    await writeFile(join(folder, 'index.js'), 'export default { name: "broken" };');
    const noSetup = harness();
    expect(await noSetup.run('plugin', 'check', folder)).toBe(1);
    expect(noSetup.err.join('\n')).toContain('must export a plugin');
    expect(await harness().run('plugin', 'pack', folder)).toBe(1);

    await writeFile(
      join(folder, 'plugin.json'),
      JSON.stringify({ name: 'other', version: '1.0.0' }),
    );
    const wrongName = harness();
    expect(await wrongName.run('plugin', 'check', folder)).toBe(1);
    expect(wrongName.err.join('\n')).toContain('folder');
  });

  it('lists the permissions and migrations of a plugin', async () => {
    const folder = join(cwd, 'db-plugin');
    await mkdir(join(folder, 'migrations', 'sqlite'), { recursive: true });
    await writeFile(
      join(folder, 'plugin.json'),
      JSON.stringify({ name: 'db-plugin', version: '1.0.0', permissions: ['database', 'network'] }),
    );
    await writeFile(join(folder, 'index.js'), 'export default { name: "db-plugin", setup() {} };');
    await writeFile(join(folder, 'migrations', 'sqlite', '0001_a.sql'), 'select 1');
    const h = harness();
    expect(await h.run('plugin', 'check', folder)).toBe(0);
    expect(h.out).toEqual([
      'db-plugin 1.0.0 is a valid plugin.',
      'Permissions: database, network',
      'It has database migrations.',
    ]);
  });
});

describe('theme create', () => {
  it('creates a theme in ./themes', async () => {
    const h = harness();
    expect(await h.run('theme', 'create', 'my-theme', '--title', 'Mine')).toBe(0);
    const manifest = JSON.parse(
      await readFile(join(cwd, 'themes', 'my-theme', 'theme.json'), 'utf8'),
    ) as {
      title: string;
    };
    expect(manifest.title).toBe('Mine');
    expect(h.out[1]).toContain('THEME=my-theme');
    expect(await harness().run('theme', 'create', 'Bad Name')).toBe(2);
  });
});

describe('migrate', () => {
  it('applies the migrations to the database in --database-url, then DATABASE_URL', async () => {
    const h = harness();
    expect(await h.run('migrate', '--database-url', `file:${join(cwd, 'a.db')}`)).toBe(0);
    expect(h.out).toEqual(['Migrations applied (sqlite).']);
    const viaEnv = harness({ DATABASE_URL: `file:${join(cwd, 'b.db')}` });
    expect(await viaEnv.run('migrate')).toBe(0);
  });

  it('fails clearly for an unsupported URL', async () => {
    const h = harness();
    expect(await h.run('migrate', '--database-url', 'mysql://x/y')).toBe(1);
    expect(h.err.join('\n')).toContain('Unsupported database URL');
  });
});

describe('dev', () => {
  async function fakeRepo(): Promise<string> {
    const main = join(cwd, 'apps', 'server', 'dist', 'main.js');
    await mkdir(join(cwd, 'apps', 'server', 'dist'), { recursive: true });
    await writeFile(main, '');
    return main;
  }

  it('finds the built server in this folder or a parent', async () => {
    expect(await findServerMain(join(cwd, 'nothing-here'))).toBeUndefined();
    const main = await fakeRepo();
    expect(await findServerMain(cwd)).toBe(main);
    await mkdir(join(cwd, 'plugins-installed', 'x'), { recursive: true });
    expect(await findServerMain(join(cwd, 'plugins-installed', 'x'))).toBe(main);
  });

  it('starts the server with the chosen port and returns its exit code', async () => {
    const main = await fakeRepo();
    const h = harness();
    expect(await h.run('dev', '--port', '4000')).toBe(0);
    expect(h.started).toEqual([{ main, env: { PORT: '4000' } }]);
  });

  it('explains what to do when the server is not built, and checks the port', async () => {
    const h = harness();
    expect(await h.run('dev')).toBe(1);
    expect(h.err.join('\n')).toContain('pnpm build');
    await fakeRepo();
    expect(await harness().run('dev', '--port', 'abc')).toBe(2);
  });
});
