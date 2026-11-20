import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { discoverPlugins, loadPluginDefinition, type DiscoveredPlugin } from '@nodepress/core';
import { createDatabase, DEFAULT_DATABASE_URL } from '@nodepress/db';
import { parseArgs, textFlag, UsageError, type ParsedArgs } from './args.js';
import { scaffoldPlugin, scaffoldTheme } from './scaffold.js';
import { writeZip, type ZipEntry } from './zip-writer.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Replaced in tests; the real one starts the server. */
  startServer?: (options: { main: string; env: Record<string, string> }) => Promise<number>;
}

export const HELP = `nodepress: the NodePress command line

Usage: nodepress <command> [options]

Commands:
  migrate                       Apply database migrations (DATABASE_URL, or --database-url)
  dev                           Start the server and restart it when files change (--port 3000)
  plugin create <name>          Create a plugin in ./plugins-installed (--dir to change)
  plugin check [folder]         Validate plugin.json and load the plugin (default: .)
  plugin pack [folder]          Make <name>-<version>.zip to upload in the admin (--out file)
  theme create <name>           Create a theme in ./themes (--dir to change)

Options:
  --title, --description        Text for a new plugin or theme
  --force                       Write into a folder that already has files
  -h, --help                    Show this help
  --version                     Show the version
`;

const VERSION = '0.0.0';
const IGNORED = new Set(['node_modules', '.git', '.DS_Store']);
const MAX_PACK_FILES = 2000;

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (IGNORED.has(entry.name) || entry.name.endsWith('.zip')) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      if (files.length > MAX_PACK_FILES) throw new Error(`more than ${MAX_PACK_FILES} files`);
    }
  };
  await walk(root);
  return files.sort();
}

/** Find and validate one plugin folder with the same code the server uses. */
async function checkPlugin(folder: string): Promise<DiscoveredPlugin> {
  const root = resolve(folder);
  if (!existsSync(join(root, 'plugin.json'))) {
    throw new UsageError(
      `${root} has no plugin.json. Run this inside a plugin folder or pass one.`,
    );
  }
  const found = await discoverPlugins(dirname(root));
  const problem = found.errors.find((error) => error.dir === basename(root));
  if (problem) throw new Error(problem.message);
  const plugin = found.plugins.find((p) => basename(p.dir) === basename(root));
  if (!plugin) throw new Error('the plugin was not found');
  await loadPluginDefinition(plugin);
  return plugin;
}

async function pluginCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const [, action, target] = args.positional;
  const title = textFlag(args, 'title');
  const description = textFlag(args, 'description');
  switch (action) {
    case 'create': {
      if (!target)
        throw new UsageError(
          'plugin create needs a name, like "nodepress plugin create my-plugin"',
        );
      const dir = resolve(io.cwd, textFlag(args, 'dir') ?? 'plugins-installed');
      const result = await scaffoldPlugin({
        name: target,
        dir,
        title,
        description,
        force: args.flags['force'] === true,
      });
      io.out(`Created ${relative(io.cwd, result.root) || '.'} with ${result.files.join(', ')}`);
      io.out(`Next: nodepress plugin check ${relative(io.cwd, result.root)}`);
      return 0;
    }
    case 'check': {
      const plugin = await checkPlugin(resolve(io.cwd, target ?? '.'));
      const { manifest } = plugin;
      io.out(`${manifest.name} ${manifest.version} is a valid plugin.`);
      io.out(
        manifest.permissions.length > 0
          ? `Permissions: ${manifest.permissions.join(', ')}`
          : 'Permissions: none',
      );
      if (plugin.hasMigrations) io.out('It has database migrations.');
      return 0;
    }
    case 'pack': {
      const folder = resolve(io.cwd, target ?? '.');
      const plugin = await checkPlugin(folder);
      const entries: ZipEntry[] = [];
      for (const file of await listFiles(folder)) {
        entries.push({
          path: relative(folder, file).split(sep).join('/'),
          data: new Uint8Array(await readFile(file)),
        });
      }
      const out = resolve(
        io.cwd,
        textFlag(args, 'out') ?? `${plugin.manifest.name}-${plugin.manifest.version}.zip`,
      );
      await writeFile(out, writeZip(entries));
      io.out(`Wrote ${relative(io.cwd, out) || out} (${entries.length} files).`);
      io.out('Upload it on the Plugins screen of the admin.');
      return 0;
    }
    default:
      throw new UsageError('plugin needs a command: create, check or pack');
  }
}

async function themeCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const [, action, target] = args.positional;
  if (action !== 'create') throw new UsageError('theme needs a command: create');
  if (!target)
    throw new UsageError('theme create needs a name, like "nodepress theme create my-theme"');
  const result = await scaffoldTheme({
    name: target,
    dir: resolve(io.cwd, textFlag(args, 'dir') ?? 'themes'),
    title: textFlag(args, 'title'),
    description: textFlag(args, 'description'),
    force: args.flags['force'] === true,
  });
  io.out(`Created ${relative(io.cwd, result.root) || '.'} with ${result.files.join(', ')}`);
  io.out(`Next: npm install && npm run build inside it, then set THEME=${target}.`);
  return 0;
}

async function migrateCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const url = textFlag(args, 'database-url') ?? io.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const handle = createDatabase({
    url,
    ...(io.env['DATABASE_AUTH_TOKEN'] ? { authToken: io.env['DATABASE_AUTH_TOKEN'] } : {}),
  });
  try {
    await handle.migrate();
    io.out(`Migrations applied (${handle.dialect}).`);
    return 0;
  } finally {
    await handle.close();
  }
}

/** The built server (`apps/server/dist/main.js`), looking in this folder and the ones above it. */
export async function findServerMain(from: string): Promise<string | undefined> {
  let folder = resolve(from);
  for (;;) {
    const candidate = join(folder, 'apps', 'server', 'dist', 'main.js');
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not here; try the parent.
    }
    const parent = dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
}

function startServerProcess(options: {
  main: string;
  env: Record<string, string>;
}): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, ['--watch', options.main], {
      stdio: 'inherit',
      env: { ...process.env, ...options.env },
    });
    child.on('exit', (code) => resolveExit(code ?? 0));
    child.on('error', () => resolveExit(1));
  });
}

async function devCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const main = await findServerMain(io.cwd);
  if (!main) {
    throw new Error(
      'Could not find apps/server/dist/main.js. Run "pnpm build" in the NodePress folder first.',
    );
  }
  const port = textFlag(args, 'port');
  if (port !== undefined && !/^\d{1,5}$/.test(port))
    throw new UsageError('--port must be a number');
  const env: Record<string, string> = { ...(port ? { PORT: port } : {}) };
  io.out(
    `Starting ${relative(io.cwd, main) || main} (restarts when files change). Press Ctrl+C to stop.`,
  );
  return (io.startServer ?? startServerProcess)({ main, env });
}

/** Runs the CLI and returns the exit code: 0 ok, 1 failed, 2 usage mistake. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.flags['version'] === true) {
      io.out(VERSION);
      return 0;
    }
    const [command] = args.positional;
    if (args.flags['help'] === true || command === undefined || command === 'help') {
      io.out(HELP);
      return 0;
    }
    switch (command) {
      case 'plugin':
        return await pluginCommand(args, io);
      case 'theme':
        return await themeCommand(args, io);
      case 'migrate':
        return await migrateCommand(args, io);
      case 'dev':
        return await devCommand(args, io);
      default:
        throw new UsageError(`Unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\nRun "nodepress --help" for usage.`);
      return 2;
    }
    io.err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
