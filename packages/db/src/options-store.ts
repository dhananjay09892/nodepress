import { eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
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

/**
 * PostgreSQL goes through raw, parameterized SQL with explicit casts instead of the `jsonb`
 * column mapper: the mapper parses JSON a second time on read, so a string option such as
 * `'{"a":1}'` or `'7'` would come back as an object or a number. Here the value is sent as
 * text and cast to jsonb, and read back as text and parsed exactly once.
 */
function postgresStore(
  db: Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
): OptionsTableStore {
  interface PgRow {
    key: string;
    value: string | null;
    autoload: boolean;
  }
  const toPgRecord = (row: PgRow): OptionRecord => ({
    key: row.key,
    value: row.value === null ? null : (JSON.parse(row.value) as unknown),
    autoload: row.autoload,
  });

  return {
    async getAutoloaded() {
      const rows = await db.execute<PgRow>(
        sql`select key, value::text as value, autoload from options where autoload = true`,
      );
      return [...rows].map(toPgRecord);
    },
    async get(key) {
      const rows = await db.execute<PgRow>(
        sql`select key, value::text as value, autoload from options where key = ${key} limit 1`,
      );
      const [row] = [...rows];
      return row ? toPgRecord(row) : undefined;
    },
    async upsert(row) {
      const json = JSON.stringify(row.value ?? null);
      await db.execute(sql`
        insert into options (key, value, autoload)
        values (${row.key}, ${json}::text::jsonb, ${row.autoload})
        on conflict (key) do update set value = excluded.value, autoload = excluded.autoload
      `);
    },
    async delete(key) {
      const rows = await db.execute<{ key: string }>(
        sql`delete from options where key = ${key} returning key`,
      );
      return [...rows].length > 0;
    },
  };
}
