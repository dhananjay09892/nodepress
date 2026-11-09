import { eq, lte } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

/** A row of the `sessions` table, the same on both dialects. `id` is the hash of the cookie token. */
export interface SessionRow {
  id: string;
  userId: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface NewSessionRow {
  id: string;
  userId: number;
  expiresAt: Date;
}

/**
 * Data access for the `sessions` table. Structurally compatible with the `SessionsStore`
 * interface of `@nodepress/core`, which this package does not import.
 */
export interface SessionsTableStore {
  insert(row: NewSessionRow): Promise<SessionRow>;
  findById(id: string): Promise<SessionRow | undefined>;
  delete(id: string): Promise<boolean>;
  deleteByUser(userId: number): Promise<number>;
  deleteExpired(now: Date): Promise<number>;
}

/** Sessions store for whichever dialect the handle uses. All queries are parameterized (Drizzle). */
export function createSessionsStore(handle: DatabaseHandle): SessionsTableStore {
  return handle.dialect === 'postgres'
    ? build(handle.db, pgSchema.sessions)
    : build(handle.db, sqliteSchema.sessions);
}

function build(
  dbAny:
    | Extract<DatabaseHandle, { dialect: 'sqlite' }>['db']
    | Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
  sessionsAny: typeof sqliteSchema.sessions | typeof pgSchema.sessions,
): SessionsTableStore {
  // The two dialects' builders are structurally identical here but nominally different types.
  const db = dbAny as Extract<DatabaseHandle, { dialect: 'sqlite' }>['db'];
  const sessions = sessionsAny as typeof sqliteSchema.sessions;

  return {
    async insert(row) {
      const [created] = await db.insert(sessions).values(row).returning();
      if (!created) throw new Error('Insert into sessions returned no row');
      return created;
    },
    async findById(id) {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return row;
    },
    async delete(id) {
      const removed = await db
        .delete(sessions)
        .where(eq(sessions.id, id))
        .returning({ id: sessions.id });
      return removed.length > 0;
    },
    async deleteByUser(userId) {
      const removed = await db
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ id: sessions.id });
      return removed.length;
    },
    async deleteExpired(now) {
      const removed = await db
        .delete(sessions)
        .where(lte(sessions.expiresAt, now))
        .returning({ id: sessions.id });
      return removed.length;
    },
  };
}
