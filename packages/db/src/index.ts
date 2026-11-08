import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export * from './schema.js';
export { schema };

export type Database = LibSQLDatabase<typeof schema>;

export interface DatabaseOptions {
  /**
   * libSQL URL. Examples:
   * - `file:./nodepress.db` (local SQLite file — the default)
   * - `:memory:` (tests)
   * - `libsql://my-site.turso.io` (hosted libSQL / Turso)
   */
  url?: string;
  authToken?: string;
}

export interface DatabaseHandle {
  db: Database;
  /** Run pending migrations shipped with @nodepress/db. */
  migrate(): Promise<void>;
  /** Returns true if the database answers a trivial query. */
  ping(): Promise<boolean>;
  close(): void;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

export function createDatabase(options: DatabaseOptions = {}): DatabaseHandle {
  const client = createClient({
    url: options.url ?? 'file:./nodepress.db',
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });
  const db = drizzle(client, { schema });

  return {
    db,
    async migrate() {
      if (!existsSync(MIGRATIONS_DIR)) {
        throw new Error(
          'No migrations found. Run `pnpm --filter @nodepress/db db:generate` to create them.',
        );
      }
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    },
    async ping() {
      try {
        await db.run(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      client.close();
    },
  };
}
