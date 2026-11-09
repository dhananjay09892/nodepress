import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

/** A row of the `media` table, the same on both dialects. */
export interface MediaRow {
  id: number;
  path: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string;
  variants: Record<string, string>;
  uploadedBy: number | null;
  createdAt: Date;
}

export interface NewMediaRow {
  path: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string;
  variants: Record<string, string>;
  uploadedBy: number | null;
}

export interface MediaRowQuery {
  limit: number;
  offset: number;
  uploadedBy?: number;
}

/**
 * Data access for the `media` table. Structurally compatible with the `MediaStore` interface
 * of `@nodepress/core`, which this package does not import.
 */
export interface MediaTableStore {
  insert(row: NewMediaRow): Promise<MediaRow>;
  findById(id: number): Promise<MediaRow | undefined>;
  list(query: MediaRowQuery): Promise<MediaRow[]>;
  updateAlt(id: number, alt: string): Promise<MediaRow | undefined>;
  delete(id: number): Promise<boolean>;
}

/** Media store for whichever dialect the handle uses. All queries are parameterized (Drizzle). */
export function createMediaStore(handle: DatabaseHandle): MediaTableStore {
  return handle.dialect === 'postgres'
    ? build(handle.db, pgSchema.media)
    : build(handle.db, sqliteSchema.media);
}

function build(
  dbAny:
    | Extract<DatabaseHandle, { dialect: 'sqlite' }>['db']
    | Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
  mediaAny: typeof sqliteSchema.media | typeof pgSchema.media,
): MediaTableStore {
  // The two dialects' builders are structurally identical here but nominally different types.
  const db = dbAny as Extract<DatabaseHandle, { dialect: 'sqlite' }>['db'];
  const media = mediaAny as typeof sqliteSchema.media;

  return {
    async insert(row) {
      const [created] = await db.insert(media).values(row).returning();
      if (!created) throw new Error('Insert into media returned no row');
      return created;
    },
    async findById(id) {
      const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
      return row;
    },
    async list(query) {
      const filters: SQL[] = [];
      if (query.uploadedBy !== undefined) filters.push(eq(media.uploadedBy, query.uploadedBy));
      return db
        .select()
        .from(media)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(media.id))
        .limit(query.limit)
        .offset(query.offset);
    },
    async updateAlt(id, alt) {
      const [row] = await db.update(media).set({ alt }).where(eq(media.id, id)).returning();
      return row;
    },
    async delete(id) {
      const removed = await db.delete(media).where(eq(media.id, id)).returning({ id: media.id });
      return removed.length > 0;
    },
  };
}
