import { count, eq } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

/** A row of the `users` table, the same on both dialects. */
export interface UserRow {
  id: number;
  email: string;
  passwordHash: string;
  displayName: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewUserRow {
  email: string;
  passwordHash: string;
  displayName: string;
  role: string;
}

export interface UserRowPatch {
  email?: string;
  passwordHash?: string;
  displayName?: string;
  role?: string;
}

/**
 * Data access for the `users` table. Structurally compatible with the `UsersStore` interface
 * of `@nodepress/core`, which this package does not import.
 */
export interface UsersTableStore {
  findById(id: number): Promise<UserRow | undefined>;
  findByEmail(email: string): Promise<UserRow | undefined>;
  list(): Promise<UserRow[]>;
  insert(row: NewUserRow): Promise<UserRow>;
  update(id: number, patch: UserRowPatch): Promise<UserRow | undefined>;
  delete(id: number): Promise<boolean>;
  countByRole(role: string): Promise<number>;
}

type Role = sqliteSchema.Role;

/** Users store for whichever dialect the handle uses. All queries are parameterized (Drizzle). */
export function createUsersStore(handle: DatabaseHandle): UsersTableStore {
  return handle.dialect === 'postgres'
    ? build(handle.db, pgSchema.users)
    : build(handle.db, sqliteSchema.users);
}

/**
 * Both dialects expose the same query-builder surface for these simple statements, so one body
 * serves both. The table argument decides which SQL is generated.
 */
function build(
  dbAny:
    | Extract<DatabaseHandle, { dialect: 'sqlite' }>['db']
    | Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
  usersAny: typeof sqliteSchema.users | typeof pgSchema.users,
): UsersTableStore {
  // The two dialects' builders are structurally identical here but nominally different types.
  const db = dbAny as Extract<DatabaseHandle, { dialect: 'sqlite' }>['db'];
  const users = usersAny as typeof sqliteSchema.users;

  return {
    async findById(id) {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row;
    },
    async findByEmail(email) {
      const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return row;
    },
    async list() {
      return db.select().from(users).orderBy(users.id);
    },
    async insert(row) {
      const [created] = await db
        .insert(users)
        .values({ ...row, role: row.role as Role })
        .returning();
      if (!created) throw new Error('Insert into users returned no row');
      return created;
    },
    async update(id, patch) {
      if (Object.keys(patch).length === 0) {
        const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
        return row;
      }
      const { role, ...rest } = patch;
      const [row] = await db
        .update(users)
        .set({
          ...rest,
          ...(role === undefined ? {} : { role: role as Role }),
          updatedAt: new Date(),
        })
        .where(eq(users.id, id))
        .returning();
      return row;
    },
    async delete(id) {
      const removed = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
      return removed.length > 0;
    },
    async countByRole(role) {
      const [row] = await db
        .select({ n: count() })
        .from(users)
        .where(eq(users.role, role as Role));
      return Number(row?.n ?? 0);
    },
  };
}
