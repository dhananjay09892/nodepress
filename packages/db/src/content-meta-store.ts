import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as sqliteSchema from './schema.js';

/**
 * Data access for the `content_meta` table: custom field values, one JSON value per item and key.
 * Rows disappear with their item (`ON DELETE CASCADE`).
 */
export interface ContentMetaTableStore {
  /** Every stored value of one item, as `{ key: value }`. */
  getMeta(contentId: number): Promise<Record<string, unknown>>;
  /** Values of several items at once. Items with no values are absent from the map. */
  getMetaMany(contentIds: number[]): Promise<Map<number, Record<string, unknown>>>;
  /** Create or replace values. A `undefined` value is skipped; use `deleteMeta` to remove a key. */
  setMeta(contentId: number, values: Record<string, unknown>): Promise<void>;
  /** Remove keys. Keys that are not stored are ignored. */
  deleteMeta(contentId: number, keys: string[]): Promise<void>;
}

/** Content meta store for whichever dialect the handle uses. All queries are parameterized (Drizzle). */
export function createContentMetaStore(handle: DatabaseHandle): ContentMetaTableStore {
  return handle.dialect === 'postgres' ? postgresStore(handle.db) : sqliteStore(handle.db);
}

function group(
  rows: { contentId: number; key: string; value: unknown }[],
): Map<number, Record<string, unknown>> {
  const result = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    const values = result.get(row.contentId) ?? {};
    values[row.key] = row.value;
    result.set(row.contentId, values);
  }
  return result;
}

function entriesOf(values: Record<string, unknown>): [string, unknown][] {
  return Object.entries(values).filter(([, value]) => value !== undefined);
}

function sqliteStore(
  db: Extract<DatabaseHandle, { dialect: 'sqlite' }>['db'],
): ContentMetaTableStore {
  const { contentMeta } = sqliteSchema;
  const many = async (contentIds: number[]) => {
    if (contentIds.length === 0) return new Map<number, Record<string, unknown>>();
    const rows = await db
      .select()
      .from(contentMeta)
      .where(inArray(contentMeta.contentId, contentIds));
    return group(rows);
  };
  return {
    async getMeta(contentId) {
      return (await many([contentId])).get(contentId) ?? {};
    },
    getMetaMany: many,
    async setMeta(contentId, values) {
      for (const [key, value] of entriesOf(values)) {
        await db
          .insert(contentMeta)
          .values({ contentId, key, value })
          .onConflictDoUpdate({
            target: [contentMeta.contentId, contentMeta.key],
            set: { value },
          });
      }
    },
    async deleteMeta(contentId, keys) {
      if (keys.length === 0) return;
      await db
        .delete(contentMeta)
        .where(and(eq(contentMeta.contentId, contentId), inArray(contentMeta.key, keys)));
    },
  };
}

/**
 * PostgreSQL goes through raw, parameterized SQL with explicit casts instead of the `jsonb`
 * column mapper, for the same reason as the options store: the mapper parses JSON a second time
 * on read, so a string value such as `'7'` or `'{"a":1}'` would come back as a number or object.
 * Here the value is sent as text, cast to jsonb, and read back as text parsed exactly once.
 */
function postgresStore(
  db: Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
): ContentMetaTableStore {
  type PgRow = { content_id: number; key: string; value: string | null };
  const many = async (contentIds: number[]) => {
    if (contentIds.length === 0) return new Map<number, Record<string, unknown>>();
    const rows = await db.execute<PgRow>(
      sql`select content_id, key, value::text as value from content_meta
          where content_id in (${sql.join(
            contentIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
    );
    return group(
      [...rows].map((row) => ({
        contentId: Number(row.content_id),
        key: row.key,
        value: row.value === null ? null : (JSON.parse(row.value) as unknown),
      })),
    );
  };
  return {
    async getMeta(contentId) {
      return (await many([contentId])).get(contentId) ?? {};
    },
    getMetaMany: many,
    async setMeta(contentId, values) {
      for (const [key, value] of entriesOf(values)) {
        const json = JSON.stringify(value ?? null);
        await db.execute(sql`
          insert into content_meta (content_id, key, value)
          values (${contentId}, ${key}, ${json}::text::jsonb)
          on conflict (content_id, key) do update set value = excluded.value
        `);
      }
    },
    async deleteMeta(contentId, keys) {
      if (keys.length === 0) return;
      await db.execute(sql`
        delete from content_meta
        where content_id = ${contentId}
          and key in (${sql.join(
            keys.map((key) => sql`${key}`),
            sql`, `,
          )})
      `);
    },
  };
}
