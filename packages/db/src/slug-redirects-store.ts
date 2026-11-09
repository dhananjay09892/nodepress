import { and, eq } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

/** A row of the `slug_redirects` table, the same on both dialects. */
export interface SlugRedirectRow {
  id: number;
  contentId: number;
  type: string;
  slug: string;
  createdAt: Date;
}

export interface NewSlugRedirectRow {
  contentId: number;
  type: string;
  slug: string;
}

/**
 * Data access for the `slug_redirects` table. Structurally compatible with the
 * `SlugRedirectStore` interface of `@nodepress/core`, which this package does not import.
 */
export interface SlugRedirectsTableStore {
  /** Remember an old slug. If (type, slug) is already remembered it now points at `contentId`. */
  upsert(row: NewSlugRedirectRow): Promise<SlugRedirectRow>;
  find(type: string, slug: string): Promise<SlugRedirectRow | undefined>;
  /** Forget an old slug. Returns true if a row was removed. */
  delete(type: string, slug: string): Promise<boolean>;
}

/** Slug redirect store for whichever dialect the handle uses. All queries are parameterized. */
export function createSlugRedirectsStore(handle: DatabaseHandle): SlugRedirectsTableStore {
  return handle.dialect === 'postgres'
    ? build(handle.db, pgSchema.slugRedirects)
    : build(handle.db, sqliteSchema.slugRedirects);
}

function build(
  dbAny:
    | Extract<DatabaseHandle, { dialect: 'sqlite' }>['db']
    | Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
  tableAny: typeof sqliteSchema.slugRedirects | typeof pgSchema.slugRedirects,
): SlugRedirectsTableStore {
  // The two dialects' builders are structurally identical here but nominally different types.
  const db = dbAny as Extract<DatabaseHandle, { dialect: 'sqlite' }>['db'];
  const table = tableAny as typeof sqliteSchema.slugRedirects;

  return {
    async upsert(row) {
      const [saved] = await db
        .insert(table)
        .values(row)
        .onConflictDoUpdate({
          target: [table.type, table.slug],
          set: { contentId: row.contentId },
        })
        .returning();
      if (!saved) throw new Error('Upsert into slug_redirects returned no row');
      return saved;
    },
    async find(type, slug) {
      const [row] = await db
        .select()
        .from(table)
        .where(and(eq(table.type, type), eq(table.slug, slug)))
        .limit(1);
      return row;
    },
    async delete(type, slug) {
      const removed = await db
        .delete(table)
        .where(and(eq(table.type, type), eq(table.slug, slug)))
        .returning({ id: table.id });
      return removed.length > 0;
    },
  };
}
