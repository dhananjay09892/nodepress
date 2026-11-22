import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  discoverPlugins,
  PluginPackageError,
  parsePluginManifest,
  type DiscoveredPlugin,
  type PluginManifest,
  type PluginStateService,
} from './plugin-packages.js';
import type { PluginInfo } from './plugins.js';
import { DEFAULT_ZIP_LIMITS, readZip, ZipError, type ZipFile, type ZipLimits } from './zip.js';

/** If every file sits in one top-level folder (as zips of a folder do), drop that folder. */
function stripCommonFolder(files: ZipFile[]): ZipFile[] {
  if (files.some((file) => file.path === 'plugin.json')) return files;
  const tops = new Set(files.map((file) => file.path.split('/')[0]));
  if (tops.size !== 1) return files;
  const [top] = [...tops];
  return files.map((file) => ({ ...file, path: file.path.slice((top as string).length + 1) }));
}

export interface InstallPluginOptions {
  /** The plugins folder (`PLUGINS_DIR`). */
  dir: string;
  /** The uploaded .zip. */
  zip: Uint8Array;
  limits?: ZipLimits;
}

/**
 * Install a plugin from an uploaded .zip: unpack it into a scratch folder inside the plugins
 * folder, check it like discovery does (valid `plugin.json`, entry inside the folder, `database`
 * permission when it has migrations), then move it into place as `<dir>/<name>`. Nothing is
 * installed when anything fails, and an installed plugin is never overwritten. The plugin stays
 * off until it is enabled. Throws `PluginPackageError`.
 */
export async function installPluginZip(options: InstallPluginOptions): Promise<DiscoveredPlugin> {
  let files: ZipFile[];
  try {
    files = stripCommonFolder(readZip(options.zip, options.limits ?? DEFAULT_ZIP_LIMITS));
  } catch (error) {
    if (error instanceof ZipError)
      throw new PluginPackageError(`The upload is not a usable zip: ${error.message}`);
    throw error;
  }
  const manifestFile = files.find((file) => file.path === 'plugin.json');
  if (!manifestFile) throw new PluginPackageError('The zip has no plugin.json at its top level');
  let manifest: PluginManifest;
  try {
    manifest = parsePluginManifest(JSON.parse(new TextDecoder().decode(manifestFile.data)));
  } catch (error) {
    throw new PluginPackageError(
      error instanceof SyntaxError ? 'plugin.json is not valid JSON' : (error as Error).message,
    );
  }

  await mkdir(options.dir, { recursive: true });
  const target = join(options.dir, manifest.name);
  if (await exists(target)) {
    throw new PluginPackageError(`"${manifest.name}" is already installed`);
  }
  const scratch = await mkdtemp(join(options.dir, '.incoming-'));
  try {
    const staged = join(scratch, manifest.name);
    for (const file of files) {
      const destination = join(staged, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.data);
    }
    const found = await discoverPlugins(scratch);
    const plugin = found.plugins[0];
    if (!plugin) {
      throw new PluginPackageError(found.errors[0]?.message ?? 'The package could not be read');
    }
    try {
      await rename(staged, target);
    } catch {
      throw new PluginPackageError(`"${manifest.name}" is already installed`);
    }
    return {
      ...plugin,
      dir: target,
      entryFile: join(target, plugin.manifest.entry),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A package as the admin shows it. */
export interface PluginPackageInfo {
  name: string;
  version: string;
  title: string;
  description: string | undefined;
  permissions: PluginManifest['permissions'];
  hasMigrations: boolean;
  /** The owner's choice (changes apply at the next start). */
  enabled: boolean;
  /** What the running site did with it: absent when it was not loaded. */
  status: PluginInfo['status'] | undefined;
  error: string | undefined;
  /** HTTP routes the running plugin added under `/api/v1/plugins/<name>/` (empty when it is off). */
  routes: NonNullable<PluginInfo['routes']>;
}

export interface BrokenPluginPackage {
  folder: string;
  message: string;
}

/** Installed packages with their enabled state and, when known, how they are running. */
export async function listPluginPackages(options: {
  dir: string;
  state: PluginStateService;
  running?: () => PluginInfo[];
}): Promise<{ plugins: PluginPackageInfo[]; broken: BrokenPluginPackage[] }> {
  const found = await discoverPlugins(options.dir);
  const enabled = new Set(await options.state.enabled());
  const running = new Map((options.running?.() ?? []).map((info) => [info.name, info]));
  return {
    plugins: found.plugins.map(({ manifest, hasMigrations }) => {
      const live = running.get(manifest.name);
      return {
        name: manifest.name,
        version: manifest.version,
        title: manifest.title,
        description: manifest.description,
        permissions: manifest.permissions,
        hasMigrations,
        enabled: enabled.has(manifest.name),
        status: live?.status,
        error: live?.error,
        routes: live?.routes ?? [],
      };
    }),
    broken: found.errors.map(({ dir, message }) => ({ folder: dir, message })),
  };
}

/** Scratch folders left by a crashed upload. Safe to call at start-up. */
export async function cleanIncomingFolders(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith('.incoming-'))
      .map((name) => rm(join(dir, name), { recursive: true, force: true })),
  );
}
