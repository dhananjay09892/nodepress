import { count, desc } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

/** A row of the `contact_submissions` table, the same on both dialects. */
export interface ContactSubmissionRow {
  id: number;
  form: string;
  name: string;
  email: string;
  message: string;
  ipHash: string;
  mailStatus: string;
  createdAt: Date;
}

export type NewContactSubmissionRow = Omit<ContactSubmissionRow, 'id' | 'createdAt'>;

/**
 * Data access for the `contact_submissions` table. Structurally compatible with the
 * `ContactSubmissionStore` interface of `@nodepress/core`, which this package does not import.
 */
export interface ContactSubmissionsTableStore {
  insert(row: NewContactSubmissionRow): Promise<ContactSubmissionRow>;
  /** Newest first. */
  list(options: { limit: number; offset: number }): Promise<ContactSubmissionRow[]>;
  count(): Promise<number>;
}

/** Contact submissions store for whichever dialect the handle uses. All queries are parameterized. */
export function createContactSubmissionsStore(handle: DatabaseHandle): ContactSubmissionsTableStore {
  return handle.dialect === 'postgres'
    ? build(handle.db, pgSchema.contactSubmissions)
    : build(handle.db, sqliteSchema.contactSubmissions);
}

function build(
  dbAny:
    | Extract<DatabaseHandle, { dialect: 'sqlite' }>['db']
    | Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
  tableAny: typeof sqliteSchema.contactSubmissions | typeof pgSchema.contactSubmissions,
): ContactSubmissionsTableStore {
  // The two dialects' builders are structurally identical here but nominally different types.
  const db = dbAny as Extract<DatabaseHandle, { dialect: 'sqlite' }>['db'];
  const table = tableAny as typeof sqliteSchema.contactSubmissions;

  return {
    async insert(row) {
      const [saved] = await db.insert(table).values(row).returning();
      if (!saved) throw new Error('Insert into contact_submissions returned no row');
      return saved;
    },
    async list({ limit, offset }) {
      return db
        .select()
        .from(table)
        .orderBy(desc(table.id))
        .limit(limit)
        .offset(offset);
    },
    async count() {
      const [row] = await db.select({ total: count() }).from(table);
      return Number(row?.total ?? 0);
    },
  };
}
