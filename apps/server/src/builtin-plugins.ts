import {
  parsePluginManifest,
  runPluginMigrations,
  type Logger,
  type OptionsService,
  type PluginManager,
  type SqlRunner,
} from '@nodepress/core';
import analyticsPlugin, { PLUGIN_DIR as ANALYTICS_DIR } from '@nodepress/plugin-analytics';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Built-in plugins that own database tables: their migrations run first, and the plugin is only
 * registered when they succeeded, so a failed migration leaves the site running without it.
 * Returns the names registered.
 */
export async function registerBuiltInDatabasePlugins(options: {
  plugins: Pick<PluginManager, 'register'>;
  runner: SqlRunner;
  options: Pick<OptionsService, 'get' | 'set'>;
  logger: Logger;
}): Promise<string[]> {
  const registered: string[] = [];
  try {
    const manifest = parsePluginManifest(
      JSON.parse(await readFile(join(ANALYTICS_DIR, 'plugin.json'), 'utf8')),
    );
    const applied = await runPluginMigrations({
      plugin: {
        manifest,
        dir: ANALYTICS_DIR,
        entryFile: join(ANALYTICS_DIR, manifest.entry),
        hasMigrations: true,
      },
      runner: options.runner,
      options: options.options,
    });
    if (applied.length > 0) options.logger.info(`Plugin "analytics": applied ${applied.join(', ')}`);
    options.plugins.register(analyticsPlugin, { permissions: manifest.permissions });
    registered.push(manifest.name);
  } catch (error) {
    options.logger.error(
      `The analytics plugin was not loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return registered;
}
