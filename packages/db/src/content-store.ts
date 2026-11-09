import { and, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';
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

export interface ContentRowQuery {
  type?: string;
  /** Match any of these statuses. */
  statuses?: string[];
  authorId?: number;
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
  /** Newest first (highest id first). */
  list(query: ContentRowQuery): Promise<ContentRow[]>;
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
      const conditions: SQL[] = [];
      if (query.type !== undefined) conditions.push(eq(content.type, query.type));
      if (query.statuses && query.statuses.length > 0) {
        conditions.push(inArray(content.status, query.statuses as sqliteSchema.ContentStatus[]));
      }
      if (query.authorId !== undefined) conditions.push(eq(content.authorId, query.authorId));
      return db
        .select()
        .from(content)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(content.id))
        .limit(query.limit)
        .offset(query.offset);
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
