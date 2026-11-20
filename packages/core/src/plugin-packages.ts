import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { silentLogger, type Logger } from './logger.js';
import type { OptionsService } from './options.js';
import type { PluginDefinition, PluginManager } from './plugins.js';

declare module './options.js' {
  interface OptionMap {
    /** Plugin migration files already applied: plugin name → file names. */
    plugin_migrations: Record<string, string[]>;
  }
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ENTRY_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.m?js$/;
const MIGRATION_FILE = /^[0-9A-Za-z_-]+\.sql$/;
export const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
export const MAX_MIGRATION_BYTES = 1024 * 1024;

/**
 * What a plugin may say it needs. Permissions are declared so the site owner can see them before
 * turning a plugin on; they are not a sandbox. Only `database` is enforced: a package with
 * migrations must declare it, because migration files run SQL with full access to the database.
 */
export const PLUGIN_PERMISSIONS = [
  'content:read',
  'content:write',
  'media:read',
  'media:write',
  'users:read',
  'options:read',
  'options:write',
  'network',
  'jobs',
  'admin',
  'database',
] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** A validated `plugin.json`. */
export interface PluginManifest {
  /** Unique kebab-case id; must equal the plugin's folder name. */
  name: string;
  version: string;
  /** Human-readable name (defaults to `name`). */
  title: string;
  description?: string;
  permissions: PluginPermission[];
  /** The module to load, relative to the plugin folder (default `index.js`). */
  entry: string;
}

export class PluginPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginPackageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the parsed contents of a `plugin.json`. Throws `PluginPackageError` with a readable message. */
export function parsePluginManifest(raw: unknown): PluginManifest {
  if (!isRecord(raw)) throw new PluginPackageError('plugin.json must be an object');
  const { name, version } = raw;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name) || name.length > 64 || name === 'core') {
    throw new PluginPackageError('"name" must be kebab-case such as "my-plugin" (max 64)');
  }
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new PluginPackageError('"version" must look like 1.2.3');
  }
  const title = raw['title'] ?? name;
  if (typeof title !== 'string' || title.trim() === '' || title.length > 100) {
    throw new PluginPackageError('"title" must be a non-empty string (max 100)');
  }
  const description = raw['description'];
  if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
    throw new PluginPackageError('"description" must be a string (max 500)');
  }
  const permissions = raw['permissions'] ?? [];
  if (!Array.isArray(permissions)) {
    throw new PluginPackageError('"permissions" must be a list');
  }
  for (const permission of permissions) {
    if (!PLUGIN_PERMISSIONS.includes(permission as PluginPermission)) {
      throw new PluginPackageError(
        `unknown permission ${JSON.stringify(permission)} (known: ${PLUGIN_PERMISSIONS.join(', ')})`,
      );
    }
  }
  const entry = raw['entry'] ?? 'index.js';
  if (typeof entry !== 'string' || !ENTRY_PATTERN.test(entry) || entry.split('/').includes('..')) {
    throw new PluginPackageError('"entry" must be a relative .js or .mjs file inside the plugin');
  }
  return {
    name,
    version,
    title: title.trim(),
    ...(typeof description === 'string' ? { description } : {}),
    permissions: [...new Set(permissions as PluginPermission[])],
    entry,
  };
}

/** A plugin package found on disk. */
export interface DiscoveredPlugin {
  manifest: PluginManifest;
  /** The plugin folder. */
  dir: string;
  /** Absolute path of the module to import. */
  entryFile: string;
  /** Whether the folder has a `migrations` folder. */
  hasMigrations: boolean;
}

export interface PluginDiscovery {
  plugins: DiscoveredPlugin[];
  /** Packages that were skipped, with the reason. A broken plugin never stops the others. */
  errors: Array<{ dir: string; message: string }>;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find plugin packages: every sub-folder of `root` with a `plugin.json`. Folders without one are
 * not plugins and are ignored. A broken package (bad manifest, folder name different from `name`,
 * entry missing or outside the folder, migrations without the `database` permission) is reported
 * in `errors` and skipped; this never throws.
 */
export async function discoverPlugins(root: string): Promise<PluginDiscovery> {
  const result: PluginDiscovery = { plugins: [], errors: [] };
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return result; // no plugins folder: nothing to load
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = join(root, entry.name);
    let text: string;
    try {
      text = await readFile(join(dir, 'plugin.json'), 'utf8');
    } catch {
      continue; // not a plugin package
    }
    try {
      if (text.length > MAX_PLUGIN_MANIFEST_BYTES) {
        throw new PluginPackageError('plugin.json is too large');
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new PluginPackageError('plugin.json is not valid JSON');
      }
      const manifest = parsePluginManifest(json);
      if (manifest.name !== entry.name) {
        throw new PluginPackageError(
          `"name" is "${manifest.name}" but the folder is "${entry.name}"`,
        );
      }
      const entryFile = resolve(dir, manifest.entry);
      const realDir = await realpath(dir);
      let realEntry: string;
      try {
        realEntry = await realpath(entryFile);
      } catch {
        throw new PluginPackageError(`entry "${manifest.entry}" does not exist`);
      }
      // A link inside the folder must not point at code outside it.
      if (!realEntry.startsWith(realDir + sep)) {
        throw new PluginPackageError('"entry" must stay inside the plugin folder');
      }
      const hasMigrations = await isDirectory(join(dir, 'migrations'));
      if (hasMigrations && !manifest.permissions.includes('database')) {
        throw new PluginPackageError(
          'has a migrations folder but does not declare the "database" permission',
        );
      }
      result.plugins.push({ manifest, dir, entryFile: realEntry, hasMigrations });
    } catch (error) {
      result.errors.push({
        dir: entry.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/** Turns a file path into its module. Defaults to a dynamic `import()`. */
export type PluginImporter = (file: string) => Promise<unknown>;
const defaultImporter: PluginImporter = (file) => import(pathToFileURL(file).href);

/**
 * Import a package's entry module and return its plugin definition (the default export, or a
 * named `plugin` export). Throws `PluginPackageError` when it is not a plugin or its `name` does
 * not match `plugin.json`.
 */
export async function loadPluginDefinition(
  plugin: DiscoveredPlugin,
  importer: PluginImporter = defaultImporter,
): Promise<PluginDefinition> {
  let loaded: unknown;
  try {
    loaded = await importer(plugin.entryFile);
  } catch (error) {
    throw new PluginPackageError(
      `could not load ${plugin.manifest.entry}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const module = isRecord(loaded) ? loaded : {};
  const definition = module['default'] ?? module['plugin'];
  if (!isRecord(definition) || typeof definition['setup'] !== 'function') {
    throw new PluginPackageError(
      `${plugin.manifest.entry} must export a plugin (use definePlugin) as its default export`,
    );
  }
  if (definition['name'] !== plugin.manifest.name) {
    throw new PluginPackageError(
      `the plugin is named "${String(definition['name'])}" but plugin.json says "${plugin.manifest.name}"`,
    );
  }
  return definition as unknown as PluginDefinition;
}

// ---------------------------------------------------------------------------------------------
// Enabled state
// ---------------------------------------------------------------------------------------------

/** A row of the `plugins` table. */
export interface PluginRow {
  name: string;
  version: string;
  enabled: boolean;
}

/** Where installed plugins and their enabled flag are kept (the `plugins` table). */
export interface PluginsStore {
  list(): Promise<PluginRow[]>;
  get(name: string): Promise<PluginRow | undefined>;
  upsert(row: PluginRow): Promise<void>;
}

/**
 * Which plugin packages the site owner turned on, kept in the `plugins` table. A package that was
 * just uploaded or copied in is off until someone turns it on. Changes apply from the next start.
 */
export class PluginStateService {
  readonly #store: PluginsStore;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(store: PluginsStore) {
    this.#store = store;
  }

  /** Names of the plugins that are on. */
  async enabled(): Promise<string[]> {
    return (await this.#store.list()).filter((row) => row.enabled).map((row) => row.name);
  }

  async isEnabled(name: string): Promise<boolean> {
    return (await this.#store.get(name))?.enabled === true;
  }

  /**
   * Turn a plugin on or off. `version` is the package's version from its manifest; it is kept up
   * to date whenever the state is saved. Returns the names now enabled.
   */
  async setEnabled(name: string, on: boolean, version: string): Promise<string[]> {
    if (!NAME_PATTERN.test(name)) throw new PluginPackageError(`"${name}" is not a plugin name`);
    if (!VERSION_PATTERN.test(version))
      throw new PluginPackageError('"version" must look like 1.2.3');
    const run = this.#queue.then(async () => {
      await this.#store.upsert({ name, version, enabled: on });
      return this.enabled();
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

// ---------------------------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------------------------

/** Runs one SQL statement against the site's database. */
export interface SqlRunner {
  readonly dialect: 'sqlite' | 'postgres';
  run(statement: string): Promise<void>;
}

/** A migration file is split into statements at lines containing only `-- statement-breakpoint`. */
export function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(/^\s*--\s*statement-breakpoint\s*$/m)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Apply a plugin's pending SQL migrations. Files live in `<plugin>/migrations/<dialect>/` (for
 * example `migrations/sqlite/0001_create_notes.sql`), run in file name order, each once; the
 * names of applied files are remembered in the `plugin_migrations` option. A migration that fails
 * stops the run (later ones wait) and the error is thrown; the failed file is not recorded.
 * Returns the names applied now.
 */
export async function runPluginMigrations(options: {
  plugin: DiscoveredPlugin;
  runner: SqlRunner;
  options: Pick<OptionsService, 'get' | 'set'>;
}): Promise<string[]> {
  const { plugin, runner } = options;
  if (!plugin.hasMigrations) return [];
  if (!plugin.manifest.permissions.includes('database')) {
    throw new PluginPackageError('migrations need the "database" permission');
  }
  const folder = join(plugin.dir, 'migrations', runner.dialect);
  let names: string[];
  try {
    names = (await readdir(folder)).filter((file) => MIGRATION_FILE.test(file)).sort();
  } catch {
    return []; // nothing for this dialect
  }
  const ledgerValue = await options.options.get('plugin_migrations');
  const ledger: Record<string, string[]> = isRecord(ledgerValue)
    ? (ledgerValue as Record<string, string[]>)
    : {};
  const done = new Set(ledger[plugin.manifest.name] ?? []);
  const applied: string[] = [];
  for (const name of names) {
    if (done.has(name)) continue;
    const text = await readFile(join(folder, name), 'utf8');
    if (text.length > MAX_MIGRATION_BYTES) {
      throw new PluginPackageError(`migration ${name} is too large`);
    }
    try {
      for (const statement of splitStatements(text)) await runner.run(statement);
    } catch (error) {
      throw new PluginPackageError(
        `migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    done.add(name);
    applied.push(name);
    // Remember each file as soon as it ran, so a later failure does not repeat earlier ones.
    const latest = await options.options.get('plugin_migrations');
    const current: Record<string, string[]> = isRecord(latest)
      ? (latest as Record<string, string[]>)
      : {};
    await options.options.set('plugin_migrations', {
      ...current,
      [plugin.manifest.name]: [...done],
    });
  }
  return applied;
}

// ---------------------------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------------------------

export interface LoadPluginPackagesOptions {
  /** The folder with the plugin packages. */
  dir: string;
  state: PluginStateService;
  plugins: Pick<PluginManager, 'register'>;
  options: Pick<OptionsService, 'get' | 'set'>;
  /** Needed to run migrations; a package with pending migrations is skipped without it. */
  runner?: SqlRunner;
  logger?: Logger;
  importer?: PluginImporter;
}

export interface LoadPluginPackagesResult {
  /** Packages registered with the plugin manager (it activates them on boot). */
  registered: string[];
  /** Packages found but off. */
  disabled: string[];
  /** Packages that could not be loaded, with the reason. */
  failed: Array<{ name: string; message: string }>;
}

/**
 * Register every enabled plugin package with the plugin manager: discover them, apply their
 * migrations, import their code. One broken package is logged and left out; the site still boots.
 * Call before `np.boot()` so the manager activates them with the built-in plugins.
 */
export async function loadPluginPackages(
  config: LoadPluginPackagesOptions,
): Promise<LoadPluginPackagesResult> {
  const logger = config.logger ?? silentLogger;
  const result: LoadPluginPackagesResult = { registered: [], disabled: [], failed: [] };
  const found = await discoverPlugins(config.dir);
  for (const { dir, message } of found.errors) {
    logger.warn(`Plugin "${dir}" skipped: ${message}`);
    result.failed.push({ name: dir, message });
  }
  const enabled = new Set(await config.state.enabled());
  for (const plugin of found.plugins) {
    const { name } = plugin.manifest;
    if (!enabled.has(name)) {
      result.disabled.push(name);
      continue;
    }
    try {
      if (plugin.hasMigrations) {
        if (!config.runner) throw new PluginPackageError('no database to run migrations on');
        const applied = await runPluginMigrations({
          plugin,
          runner: config.runner,
          options: config.options,
        });
        if (applied.length > 0) logger.info(`Plugin "${name}": applied ${applied.join(', ')}`);
      }
      config.plugins.register(await loadPluginDefinition(plugin, config.importer));
      result.registered.push(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Plugin "${name}" was not loaded: ${message}`);
      result.failed.push({ name, message });
    }
  }
  return result;
}
