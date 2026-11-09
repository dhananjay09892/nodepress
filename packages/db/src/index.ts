import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleLibsql, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate as migrateLibsql } from 'drizzle-orm/libsql/migrator';
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { DEFAULT_DATABASE_URL, detectDialect, migrationsSubdir, type Dialect } from './dialect.js';
import * as pgSchema from './schema.pg.js';
import * as schema from './schema.js';

export * from './schema.js';
export * from './dialect.js';
/** SQLite tables (also exported at the top level for backwards compatibility). */
export { schema, schema as sqliteSchema };
/** PostgreSQL tables: same names and row shapes as the SQLite ones. */
export { pgSchema };

/** Drizzle database for the SQLite/libSQL dialect. */
export type Database = LibSQLDatabase<typeof schema>;
/** Drizzle database for the PostgreSQL dialect. */
export type PostgresDatabase = PostgresJsDatabase<typeof pgSchema>;

export interface DatabaseOptions {
  /**
   * Database URL. The dialect is picked from it:
   * - `file:./nodepress.db` (local SQLite file — the default)
   * - `:memory:` (tests)
   * - `libsql://my-site.turso.io` (hosted libSQL / Turso)
   * - `postgres://user:pass@host:5432/db` (PostgreSQL)
   */
  url?: string;
  /** libSQL auth token (Turso). Ignored for PostgreSQL. */
  authToken?: string;
  /** Maximum PostgreSQL pool size (default 10). Ignored for SQLite. */
  maxConnections?: number;
}

interface BaseDatabaseHandle {
  readonly dialect: Dialect;
  /** Run pending migrations shipped with @nodepress/db for this dialect. */
  migrate(): Promise<void>;
  /** Returns true if the database answers a trivial query. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface SqliteDatabaseHandle extends BaseDatabaseHandle {
  readonly dialect: 'sqlite';
  db: Database;
}

export interface PostgresDatabaseHandle extends BaseDatabaseHandle {
  readonly dialect: 'postgres';
  db: PostgresDatabase;
}

/** Narrow on `handle.dialect` to get the matching typed `db`. */
export type DatabaseHandle = SqliteDatabaseHandle | PostgresDatabaseHandle;

/** Absolute path of the migrations folder for a dialect. */
export function migrationsFolder(dialect: Dialect): string {
  return fileURLToPath(new URL(`../${migrationsSubdir(dialect)}`, import.meta.url));
}

function assertMigrations(dialect: Dialect): string {
  const folder = migrationsFolder(dialect);
  if (!existsSync(folder)) {
    throw new Error(
      `No ${dialect} migrations found. Run \`pnpm --filter @nodepress/db db:generate\` to create them.`,
    );
  }
  return folder;
}

export function createDatabase(options: DatabaseOptions = {}): DatabaseHandle {
  const url = options.url ?? DEFAULT_DATABASE_URL;
  return detectDialect(url) === 'postgres'
    ? createPostgresDatabase(url, options)
    : createSqliteDatabase(url, options);
}

function createSqliteDatabase(url: string, options: DatabaseOptions): SqliteDatabaseHandle {
  const client = createClient({
    url,
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });
  const db = drizzleLibsql(client, { schema });

  return {
    dialect: 'sqlite',
    db,
    async migrate() {
      await migrateLibsql(db, { migrationsFolder: assertMigrations('sqlite') });
    },
    async ping() {
      try {
        await db.run(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      client.close();
    },
  };
}

function createPostgresDatabase(url: string, options: DatabaseOptions): PostgresDatabaseHandle {
  // postgres.js connects lazily, so creating the handle never blocks or throws on a down server.
  const client = postgres(url, {
    max: options.maxConnections ?? 10,
    onnotice: () => {}, // keep "relation already exists, skipping" notices out of the logs
  });
  const db = drizzlePostgres(client, { schema: pgSchema });

  return {
    dialect: 'postgres',
    db,
    async migrate() {
      await migratePostgres(db, { migrationsFolder: assertMigrations('postgres') });
    },
    async ping() {
      try {
        await db.execute(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

export { createOptionsStore, type OptionRecord, type OptionsTableStore } from './options-store.js';
export {
  createUsersStore,
  type UserRow,
  type NewUserRow,
  type UserRowPatch,
  type UsersTableStore,
} from './users-store.js';
export {
  createSessionsStore,
  type SessionRow,
  type NewSessionRow,
  type SessionsTableStore,
} from './sessions-store.js';
