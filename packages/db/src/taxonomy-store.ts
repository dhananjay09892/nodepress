import { and, asc, count, desc as sqlDesc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

/** A row of the `terms` table, the same on both dialects. */
export interface TermRow {
  id: number;
  taxonomy: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: number | null;
}

export interface NewTermRow {
  taxonomy: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: number | null;
}

/** Fields that may change after creation. The taxonomy never changes. */
export type TermRowPatch = Partial<Omit<NewTermRow, 'taxonomy'>>;

/**
 * Data access for the `terms` and `term_relations` tables. Structurally compatible with the
 * `TaxonomyStore` interface of `@nodepress/core`, which this package does not import.
 */
export interface TaxonomyTableStore {
  insertTerm(row: NewTermRow): Promise<TermRow>;
  findTermById(id: number): Promise<TermRow | undefined>;
  findTermBySlug(taxonomy: string, slug: string): Promise<TermRow | undefined>;
  /** True if another term of this taxonomy already uses the slug (ignoring `excludeId`). */
  slugExists(taxonomy: string, slug: string, excludeId?: number): Promise<boolean>;
  updateTerm(id: number, patch: TermRowPatch): Promise<TermRow | undefined>;
  /** Deletes the term and its content relations. Children are left with no parent. */
  deleteTerm(id: number): Promise<boolean>;
  /** Move every direct child of `fromParentId` under `toParentId` (or to the top level). */
  reparentChildren(fromParentId: number, toParentId: number | null): Promise<void>;
  /** Ordered by name, then id. */
  listTerms(taxonomy: string): Promise<TermRow[]>;
  /** The content type of an item, or `undefined` if it does not exist. */
  findContentType(contentId: number): Promise<string | undefined>;
  /** Idempotent: terms already assigned are left alone. */
  addRelations(contentId: number, termIds: number[]): Promise<void>;
  removeRelations(contentId: number, termIds: number[]): Promise<void>;
  /** Terms assigned to an item, optionally of one taxonomy. Ordered by name, then id. */
  listTermsForContent(contentId: number, taxonomy?: string): Promise<TermRow[]>;
  /** Ids of items that have any of these terms, newest (highest id) first. */
  listContentIdsForTerms(termIds: number[], limit: number, offset: number): Promise<number[]>;
  /** How many items have each term (terms with none are absent from the map). */
  countContentByTerm(termIds: number[]): Promise<Map<number, number>>;
}

/** Taxonomy store for whichever dialect the handle uses. All queries are parameterized (Drizzle). */
export function createTaxonomyStore(handle: DatabaseHandle): TaxonomyTableStore {
  return handle.dialect === 'postgres'
    ? build(handle.db, pgSchema.terms, pgSchema.termRelations, pgSchema.content)
    : build(handle.db, sqliteSchema.terms, sqliteSchema.termRelations, sqliteSchema.content);
}

function build(
  dbAny:
    | Extract<DatabaseHandle, { dialect: 'sqlite' }>['db']
    | Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
  termsAny: typeof sqliteSchema.terms | typeof pgSchema.terms,
  relationsAny: typeof sqliteSchema.termRelations | typeof pgSchema.termRelations,
  contentAny: typeof sqliteSchema.content | typeof pgSchema.content,
): TaxonomyTableStore {
  // The two dialects' builders are structurally identical here but nominally different types.
  const db = dbAny as Extract<DatabaseHandle, { dialect: 'sqlite' }>['db'];
  const terms = termsAny as typeof sqliteSchema.terms;
  const relations = relationsAny as typeof sqliteSchema.termRelations;
  const content = contentAny as typeof sqliteSchema.content;

  const termColumns = {
    id: terms.id,
    taxonomy: terms.taxonomy,
    name: terms.name,
    slug: terms.slug,
    description: terms.description,
    parentId: terms.parentId,
  };

  return {
    async insertTerm(row) {
      const [created] = await db.insert(terms).values(row).returning();
      if (!created) throw new Error('Insert into terms returned no row');
      return created;
    },
    async findTermById(id) {
      const [row] = await db.select().from(terms).where(eq(terms.id, id)).limit(1);
      return row;
    },
    async findTermBySlug(taxonomy, slug) {
      const [row] = await db
        .select()
        .from(terms)
        .where(and(eq(terms.taxonomy, taxonomy), eq(terms.slug, slug)))
        .limit(1);
      return row;
    },
    async slugExists(taxonomy, slug, excludeId) {
      const conditions = [eq(terms.taxonomy, taxonomy), eq(terms.slug, slug)];
      if (excludeId !== undefined) conditions.push(ne(terms.id, excludeId));
      const rows = await db
        .select({ id: terms.id })
        .from(terms)
        .where(and(...conditions))
        .limit(1);
      return rows.length > 0;
    },
    async updateTerm(id, patch) {
      if (Object.keys(patch).length === 0) {
        const [row] = await db.select().from(terms).where(eq(terms.id, id)).limit(1);
        return row;
      }
      const [row] = await db.update(terms).set(patch).where(eq(terms.id, id)).returning();
      return row;
    },
    async deleteTerm(id) {
      const removed = await db.delete(terms).where(eq(terms.id, id)).returning({ id: terms.id });
      return removed.length > 0;
    },
    async reparentChildren(fromParentId, toParentId) {
      await db
        .update(terms)
        .set({ parentId: toParentId })
        .where(eq(terms.parentId, fromParentId));
    },
    async listTerms(taxonomy) {
      return db
        .select()
        .from(terms)
        .where(eq(terms.taxonomy, taxonomy))
        .orderBy(asc(terms.name), asc(terms.id));
    },
    async findContentType(contentId) {
      const [row] = await db
        .select({ type: content.type })
        .from(content)
        .where(eq(content.id, contentId))
        .limit(1);
      return row?.type;
    },
    async addRelations(contentId, termIds) {
      if (termIds.length === 0) return;
      await db
        .insert(relations)
        .values(termIds.map((termId) => ({ contentId, termId })))
        .onConflictDoNothing();
    },
    async removeRelations(contentId, termIds) {
      if (termIds.length === 0) return;
      await db
        .delete(relations)
        .where(and(eq(relations.contentId, contentId), inArray(relations.termId, termIds)));
    },
    async listTermsForContent(contentId, taxonomy) {
      const conditions: SQL[] = [eq(relations.contentId, contentId)];
      if (taxonomy !== undefined) conditions.push(eq(terms.taxonomy, taxonomy));
      return db
        .select(termColumns)
        .from(relations)
        .innerJoin(terms, eq(relations.termId, terms.id))
        .where(and(...conditions))
        .orderBy(asc(terms.name), asc(terms.id));
    },
    async listContentIdsForTerms(termIds, limit, offset) {
      if (termIds.length === 0) return [];
      const rows = await db
        .selectDistinct({ contentId: relations.contentId })
        .from(relations)
        .where(inArray(relations.termId, termIds))
        .orderBy(sqlDesc(relations.contentId))
        .limit(limit)
        .offset(offset);
      return rows.map((r) => r.contentId);
    },
    async countContentByTerm(termIds) {
      const counts = new Map<number, number>();
      if (termIds.length === 0) return counts;
      const rows = await db
        .select({ termId: relations.termId, total: count() })
        .from(relations)
        .where(inArray(relations.termId, termIds))
        .groupBy(relations.termId);
      for (const row of rows) counts.set(row.termId, Number(row.total));
      return counts;
    },
  };
}
