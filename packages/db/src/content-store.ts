import { and, asc, count, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

/** A block of editor content, the same shape on both dialects. */
export interface ContentBlockRow {
  type: string;
  attrs?: Record<string, unknown>;
  children?: ContentBlockRow[];
  text?: string;
}

/** A row of the `content` table, the same on both dialects. */
export interface ContentRow {
  id: number;
  type: string;
  status: string;
  title: string;
  slug: string;
  body: ContentBlockRow[];
  excerpt: string | null;
  authorId: number | null;
  parentId: number | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewContentRow {
  type: string;
  status: string;
  title: string;
  slug: string;
  body: ContentBlockRow[];
  excerpt: string | null;
  authorId: number | null;
  parentId: number | null;
  publishedAt: Date | null;
}

/** Fields that may change after creation. The content type never changes. */
export type ContentRowPatch = Partial<Omit<NewContentRow, 'type'>>;

/** Which rows match. */
export interface ContentRowFilter {
  type?: string;
  /** Match any of these statuses. */
  statuses?: string[];
  authorId?: number;
  /** Exact slug. */
  slug?: string;
  /** Case-insensitive text the title must contain. `%`, `_` and `\` are matched literally. */
  search?: string;
}

export interface ContentRowQuery extends ContentRowFilter {
  /** Default `id`. */
  orderBy?: 'id' | 'title' | 'createdAt' | 'updatedAt' | 'publishedAt';
  /** Default `desc`. */
  direction?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/** A row of the `revisions` table, the same on both dialects. */
export interface RevisionRow {
  id: number;
  contentId: number;
  snapshot: unknown;
  authorId: number | null;
  createdAt: Date;
}

/**
 * Data access for the `content` and `revisions` tables. Structurally compatible with the
 * `ContentStore` interface of `@nodepress/core`, which this package does not import.
 */
export interface ContentTableStore {
  insert(row: NewContentRow): Promise<ContentRow>;
  findById(id: number): Promise<ContentRow | undefined>;
  findBySlug(type: string, slug: string): Promise<ContentRow | undefined>;
  /** True if another row of this type already uses the slug (ignoring `excludeId`). */
  slugExists(type: string, slug: string, excludeId?: number): Promise<boolean>;
  update(id: number, patch: ContentRowPatch): Promise<ContentRow | undefined>;
  delete(id: number): Promise<boolean>;
  /** Newest first (highest id first) unless the query says otherwise. */
  list(query: ContentRowQuery): Promise<ContentRow[]>;
  /** How many rows match, ignoring paging. */
  count(filter: ContentRowFilter): Promise<number>;
  insertRevision(row: {
    contentId: number;
    snapshot: unknown;
    authorId: number | null;
  }): Promise<RevisionRow>;
  /** Newest first. */
  listRevisions(contentId: number): Promise<RevisionRow[]>;
  findRevision(id: number): Promise<RevisionRow | undefined>;
}

/** Content store for whichever dialect the handle uses. All queries are parameterized (Drizzle). */
export function createContentStore(handle: DatabaseHandle): ContentTableStore {
  return handle.dialect === 'postgres'
    ? build(handle.db, pgSchema.content, pgSchema.revisions)
    : build(handle.db, sqliteSchema.content, sqliteSchema.revisions);
}

function build(
  dbAny:
    | Extract<DatabaseHandle, { dialect: 'sqlite' }>['db']
    | Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
  contentAny: typeof sqliteSchema.content | typeof pgSchema.content,
  revisionsAny: typeof sqliteSchema.revisions | typeof pgSchema.revisions,
): ContentTableStore {
  // The two dialects' builders are structurally identical here but nominally different types.
  const db = dbAny as Extract<DatabaseHandle, { dialect: 'sqlite' }>['db'];
  const content = contentAny as typeof sqliteSchema.content;
  const revisions = revisionsAny as typeof sqliteSchema.revisions;

  const where = (filter: ContentRowFilter): SQL | undefined => {
    const conditions: SQL[] = [];
    if (filter.type !== undefined) conditions.push(eq(content.type, filter.type));
    if (filter.statuses && filter.statuses.length > 0) {
      conditions.push(inArray(content.status, filter.statuses as sqliteSchema.ContentStatus[]));
    }
    if (filter.authorId !== undefined) conditions.push(eq(content.authorId, filter.authorId));
    if (filter.slug !== undefined) conditions.push(eq(content.slug, filter.slug));
    if (filter.search !== undefined && filter.search !== '') {
      const pattern = `%${filter.search.replace(/[\\%_]/g, '\\$&').toLowerCase()}%`;
      conditions.push(sql`lower(${content.title}) like ${pattern} escape '\\'`);
    }
    return conditions.length > 0 ? and(...conditions) : undefined;
  };

  return {
    async insert(row) {
      const [created] = await db
        .insert(content)
        .values(row as typeof content.$inferInsert)
        .returning();
      if (!created) throw new Error('Insert into content returned no row');
      return created;
    },
    async findById(id) {
      const [row] = await db.select().from(content).where(eq(content.id, id)).limit(1);
      return row;
    },
    async findBySlug(type, slug) {
      const [row] = await db
        .select()
        .from(content)
        .where(and(eq(content.type, type), eq(content.slug, slug)))
        .limit(1);
      return row;
    },
    async slugExists(type, slug, excludeId) {
      const conditions = [eq(content.type, type), eq(content.slug, slug)];
      if (excludeId !== undefined) conditions.push(ne(content.id, excludeId));
      const rows = await db
        .select({ id: content.id })
        .from(content)
        .where(and(...conditions))
        .limit(1);
      return rows.length > 0;
    },
    async update(id, patch) {
      const [row] = await db
        .update(content)
        .set({ ...(patch as Partial<typeof content.$inferInsert>), updatedAt: new Date() })
        .where(eq(content.id, id))
        .returning();
      return row;
    },
    async delete(id) {
      const removed = await db.delete(content).where(eq(content.id, id)).returning({
        id: content.id,
      });
      return removed.length > 0;
    },
    async list(query) {
      const direction = query.direction === 'asc' ? asc : desc;
      const column = content[query.orderBy ?? 'id'];
      return (
        db
          .select()
          .from(content)
          .where(where(query))
          // The id breaks ties so paging is stable when many rows share a value.
          .orderBy(direction(column), direction(content.id))
          .limit(query.limit)
          .offset(query.offset)
      );
    },
    async count(filter) {
      const [row] = await db.select({ value: count() }).from(content).where(where(filter));
      return Number(row?.value ?? 0);
    },
    async insertRevision(row) {
      const [created] = await db.insert(revisions).values(row).returning();
      if (!created) throw new Error('Insert into revisions returned no row');
      return created;
    },
    async listRevisions(contentId) {
      return db
        .select()
        .from(revisions)
        .where(eq(revisions.contentId, contentId))
        .orderBy(desc(revisions.id));
    },
    async findRevision(id) {
      const [row] = await db.select().from(revisions).where(eq(revisions.id, id)).limit(1);
      return row;
    },
  };
}
