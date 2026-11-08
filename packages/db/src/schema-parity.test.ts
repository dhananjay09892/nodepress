import { getTableConfig as getPgTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig as getSqliteTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as pg from './schema.pg.js';
import * as sqlite from './schema.js';

/**
 * The two dialect schemas must describe the same database: same tables,
 * columns, nullability, keys, indexes and foreign keys, and the same row types.
 */

type Shape = ReturnType<typeof describeSqlite>;

function columns(
  cols: { name: string; notNull: boolean; primary: boolean; isUnique: boolean; hasDefault: boolean }[],
) {
  return cols
    .map((c) => ({
      name: c.name,
      notNull: c.notNull,
      primary: c.primary,
      unique: c.isUnique,
      // Auto-increment / identity ids are generated differently per dialect.
      hasDefault: c.primary ? null : c.hasDefault,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function describeSqlite(table: SQLiteTable) {
  const t = getSqliteTableConfig(table);
  return {
    name: t.name,
    columns: columns(t.columns),
    primaryKeys: t.primaryKeys.map((pk) => pk.columns.map((c) => c.name)),
    indexes: t.indexes
      .map((i) => ({ name: i.config.name, unique: i.config.unique }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: t.foreignKeys
      .map((fk) => {
        const ref = fk.reference();
        return {
          columns: ref.columns.map((c) => c.name),
          table: getSqliteTableConfig(ref.foreignTable).name,
          foreignColumns: ref.foreignColumns.map((c) => c.name),
          onDelete: fk.onDelete ?? null,
        };
      })
      .sort((a, b) => a.columns.join().localeCompare(b.columns.join())),
  };
}

function describePg(table: PgTable): Shape {
  const t = getPgTableConfig(table);
  return {
    name: t.name,
    columns: columns(t.columns),
    primaryKeys: t.primaryKeys.map((pk) => pk.columns.map((c) => c.name)),
    indexes: t.indexes
      .map((i) => ({ name: i.config.name ?? '', unique: i.config.unique }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: t.foreignKeys
      .map((fk) => {
        const ref = fk.reference();
        return {
          columns: ref.columns.map((c) => c.name),
          table: getPgTableConfig(ref.foreignTable).name,
          foreignColumns: ref.foreignColumns.map((c) => c.name),
          onDelete: fk.onDelete ?? null,
        };
      })
      .sort((a, b) => a.columns.join().localeCompare(b.columns.join())),
  };
}

const sqliteTables = sqlite as unknown as Record<string, SQLiteTable>;
const pgTables = pg as unknown as Record<string, PgTable>;

describe('schema parity (SQLite ↔ PostgreSQL)', () => {
  it('exports the same tables', () => {
    expect(Object.keys(pgTables).sort()).toEqual(Object.keys(sqliteTables).sort());
    expect(Object.keys(sqliteTables).length).toBeGreaterThan(0);
  });

  it.each(Object.keys(sqliteTables).sort())('%s has the same columns, keys and indexes', (key) => {
    const sqliteTable = sqliteTables[key];
    const pgTable = pgTables[key];
    expect(sqliteTable).toBeDefined();
    expect(pgTable).toBeDefined();
    expect(describePg(pgTable!)).toEqual(describeSqlite(sqliteTable!));
  });

  it('infers the same row types', () => {
    expectTypeOf<typeof pg.users.$inferSelect>().toEqualTypeOf<typeof sqlite.users.$inferSelect>();
    expectTypeOf<typeof pg.sessions.$inferSelect>().toEqualTypeOf<
      typeof sqlite.sessions.$inferSelect
    >();
    expectTypeOf<typeof pg.apiTokens.$inferSelect>().toEqualTypeOf<
      typeof sqlite.apiTokens.$inferSelect
    >();
    expectTypeOf<typeof pg.content.$inferSelect>().toEqualTypeOf<
      typeof sqlite.content.$inferSelect
    >();
    expectTypeOf<typeof pg.contentMeta.$inferSelect>().toEqualTypeOf<
      typeof sqlite.contentMeta.$inferSelect
    >();
    expectTypeOf<typeof pg.revisions.$inferSelect>().toEqualTypeOf<
      typeof sqlite.revisions.$inferSelect
    >();
    expectTypeOf<typeof pg.terms.$inferSelect>().toEqualTypeOf<typeof sqlite.terms.$inferSelect>();
    expectTypeOf<typeof pg.termRelations.$inferSelect>().toEqualTypeOf<
      typeof sqlite.termRelations.$inferSelect
    >();
    expectTypeOf<typeof pg.media.$inferSelect>().toEqualTypeOf<typeof sqlite.media.$inferSelect>();
    expectTypeOf<typeof pg.options.$inferSelect>().toEqualTypeOf<
      typeof sqlite.options.$inferSelect
    >();
    expectTypeOf<typeof pg.plugins.$inferSelect>().toEqualTypeOf<
      typeof sqlite.plugins.$inferSelect
    >();
    expectTypeOf<typeof pg.jobs.$inferSelect>().toEqualTypeOf<typeof sqlite.jobs.$inferSelect>();
  });
});
