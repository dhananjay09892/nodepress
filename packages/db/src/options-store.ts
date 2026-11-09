import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

/** A row of the `options` table, the same on both dialects. */
export interface OptionRecord {
  key: string;
  value: unknown;
  autoload: boolean;
}

/**
 * Data access for the `options` table. Structurally compatible with the
 * `OptionsStore` interface of `@nodepress/core`, which this package does not import.
 */
export interface OptionsTableStore {
  getAutoloaded(): Promise<OptionRecord[]>;
  get(key: string): Promise<OptionRecord | undefined>;
  upsert(row: OptionRecord): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Options store for whichever dialect the handle uses. All queries are parameterized (Drizzle). */
export function createOptionsStore(handle: DatabaseHandle): OptionsTableStore {
  return handle.dialect === 'postgres' ? postgresStore(handle.db) : sqliteStore(handle.db);
}

function toRecord(row: { key: string; value: unknown; autoload: boolean }): OptionRecord {
  return { key: row.key, value: row.value, autoload: row.autoload };
}

function sqliteStore(db: Extract<DatabaseHandle, { dialect: 'sqlite' }>['db']): OptionsTableStore {
  const { options } = sqliteSchema;
  return {
    async getAutoloaded() {
      const rows = await db.select().from(options).where(eq(options.autoload, true));
      return rows.map(toRecord);
    },
    async get(key) {
      const [row] = await db.select().from(options).where(eq(options.key, key)).limit(1);
      return row ? toRecord(row) : undefined;
    },
    async upsert(row) {
      await db
        .insert(options)
        .values(row)
        .onConflictDoUpdate({
          target: options.key,
          set: { value: row.value, autoload: row.autoload },
        });
    },
    async delete(key) {
      const removed = await db.delete(options).where(eq(options.key, key)).returning();
      return removed.length > 0;
    },
  };
}

function postgresStore(
  db: Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
): OptionsTableStore {
  const { options } = pgSchema;
  return {
    async getAutoloaded() {
      const rows = await db.select().from(options).where(eq(options.autoload, true));
      return rows.map(toRecord);
    },
    async get(key) {
      const [row] = await db.select().from(options).where(eq(options.key, key)).limit(1);
      return row ? toRecord(row) : undefined;
    },
    async upsert(row) {
      await db
        .insert(options)
        .values(row)
        .onConflictDoUpdate({
          target: options.key,
          set: { value: row.value, autoload: row.autoload },
        });
    },
    async delete(key) {
      const removed = await db.delete(options).where(eq(options.key, key)).returning();
      return removed.length > 0;
    },
  };
}
