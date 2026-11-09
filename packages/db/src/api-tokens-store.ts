import { and, count, eq } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

/** A row of the `api_tokens` table, the same on both dialects. `tokenHash` is the SHA-256 of the secret. */
export interface ApiTokenRow {
  id: number;
  userId: number;
  name: string;
  tokenHash: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface NewApiTokenRow {
  userId: number;
  name: string;
  tokenHash: string;
  expiresAt: Date | null;
}

/**
 * Data access for the `api_tokens` table. Structurally compatible with the `ApiTokensStore`
 * interface of `@nodepress/core`, which this package does not import.
 */
export interface ApiTokensTableStore {
  insert(row: NewApiTokenRow): Promise<ApiTokenRow>;
  findByHash(tokenHash: string): Promise<ApiTokenRow | undefined>;
  listByUser(userId: number): Promise<ApiTokenRow[]>;
  countByUser(userId: number): Promise<number>;
  delete(id: number, userId: number): Promise<boolean>;
  deleteByUser(userId: number): Promise<number>;
  touch(id: number, at: Date): Promise<void>;
}

/** API tokens store for whichever dialect the handle uses. All queries are parameterized (Drizzle). */
export function createApiTokensStore(handle: DatabaseHandle): ApiTokensTableStore {
  return handle.dialect === 'postgres'
    ? build(handle.db, pgSchema.apiTokens)
    : build(handle.db, sqliteSchema.apiTokens);
}

function build(
  dbAny:
    | Extract<DatabaseHandle, { dialect: 'sqlite' }>['db']
    | Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
  tokensAny: typeof sqliteSchema.apiTokens | typeof pgSchema.apiTokens,
): ApiTokensTableStore {
  // The two dialects' builders are structurally identical here but nominally different types.
  const db = dbAny as Extract<DatabaseHandle, { dialect: 'sqlite' }>['db'];
  const tokens = tokensAny as typeof sqliteSchema.apiTokens;

  return {
    async insert(row) {
      const [created] = await db.insert(tokens).values(row).returning();
      if (!created) throw new Error('Insert into api_tokens returned no row');
      return created;
    },
    async findByHash(tokenHash) {
      const [row] = await db.select().from(tokens).where(eq(tokens.tokenHash, tokenHash)).limit(1);
      return row;
    },
    async listByUser(userId) {
      return db.select().from(tokens).where(eq(tokens.userId, userId)).orderBy(tokens.id);
    },
    async countByUser(userId) {
      const [row] = await db
        .select({ value: count() })
        .from(tokens)
        .where(eq(tokens.userId, userId));
      return Number(row?.value ?? 0);
    },
    async delete(id, userId) {
      const removed = await db
        .delete(tokens)
        .where(and(eq(tokens.id, id), eq(tokens.userId, userId)))
        .returning({ id: tokens.id });
      return removed.length > 0;
    },
    async deleteByUser(userId) {
      const removed = await db
        .delete(tokens)
        .where(eq(tokens.userId, userId))
        .returning({ id: tokens.id });
      return removed.length;
    },
    async touch(id, at) {
      await db.update(tokens).set({ lastUsedAt: at }).where(eq(tokens.id, id));
    },
  };
}
