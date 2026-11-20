import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

/** A row of the `plugins` table (without its `settings`), the same on both dialects. */
export interface PluginRecord {
  name: string;
  version: string;
  enabled: boolean;
}

/**
 * Data access for the `plugins` table: which plugin packages are installed and turned on.
 * Structurally compatible with the `PluginsStore` interface of `@nodepress/core`, which this
 * package does not import.
 */
export interface PluginsTableStore {
  list(): Promise<PluginRecord[]>;
  get(name: string): Promise<PluginRecord | undefined>;
  /** Insert the plugin or change its version and enabled flag. */
  upsert(row: PluginRecord): Promise<void>;
}

/** Plugins store for whichever dialect the handle uses. All queries are parameterized (Drizzle). */
export function createPluginsStore(handle: DatabaseHandle): PluginsTableStore {
  if (handle.dialect === 'postgres') {
    const { db } = handle;
    const { plugins } = pgSchema;
    const toRecord = (row: { name: string; version: string; enabled: boolean }): PluginRecord => ({
      name: row.name,
      version: row.version,
      enabled: row.enabled,
    });
    return {
      async list() {
        return (await db.select().from(plugins).orderBy(plugins.name)).map(toRecord);
      },
      async get(name) {
        const [row] = await db.select().from(plugins).where(eq(plugins.name, name)).limit(1);
        return row ? toRecord(row) : undefined;
      },
      async upsert(row) {
        await db
          .insert(plugins)
          .values({ name: row.name, version: row.version, enabled: row.enabled })
          .onConflictDoUpdate({
            target: plugins.name,
            set: { version: row.version, enabled: row.enabled },
          });
      },
    };
  }
  const { db } = handle;
  const { plugins } = sqliteSchema;
  const toRecord = (row: { name: string; version: string; enabled: boolean }): PluginRecord => ({
    name: row.name,
    version: row.version,
    enabled: row.enabled,
  });
  return {
    async list() {
      return (await db.select().from(plugins).orderBy(plugins.name)).map(toRecord);
    },
    async get(name) {
      const [row] = await db.select().from(plugins).where(eq(plugins.name, name)).limit(1);
      return row ? toRecord(row) : undefined;
    },
    async upsert(row) {
      await db
        .insert(plugins)
        .values({ name: row.name, version: row.version, enabled: row.enabled })
        .onConflictDoUpdate({
          target: plugins.name,
          set: { version: row.version, enabled: row.enabled },
        });
    },
  };
}
