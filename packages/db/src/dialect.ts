/**
 * Database dialect selection. Kept free of driver imports so it can be used
 * (and tested) anywhere.
 */

export type Dialect = 'sqlite' | 'postgres';

export const DIALECTS: readonly Dialect[] = ['sqlite', 'postgres'];

/** The URL used when none is configured: a local SQLite file. */
export const DEFAULT_DATABASE_URL = 'file:./nodepress.db';

const SQLITE_PROTOCOLS = new Set(['file:', 'libsql:', 'http:', 'https:', 'ws:', 'wss:']);
const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

/**
 * Pick the dialect from a database URL.
 *
 * - `postgres://…` / `postgresql://…` → PostgreSQL
 * - `file:…`, `:memory:`, `libsql://…` and libSQL's `http(s)://` / `ws(s)://` → SQLite (libSQL)
 *
 * Throws on anything else, so a typo never silently creates a local SQLite file.
 */
export function detectDialect(url: string): Dialect {
  const trimmed = url.trim();
  if (trimmed === ':memory:') return 'sqlite';

  const match = /^([a-z][a-z0-9+.-]*:)/i.exec(trimmed);
  const protocol = match?.[1]?.toLowerCase();
  if (protocol && POSTGRES_PROTOCOLS.has(protocol)) return 'postgres';
  if (protocol && SQLITE_PROTOCOLS.has(protocol)) return 'sqlite';

  throw new Error(
    `Unsupported database URL "${redactUrl(trimmed)}". ` +
      'Use postgres://… for PostgreSQL, or file:…, :memory: or libsql://… for SQLite.',
  );
}

/** Folder (relative to the package root) holding the migrations for a dialect. */
export function migrationsSubdir(dialect: Dialect): string {
  return `drizzle/${dialect}`;
}

/** Hide credentials before a URL ends up in an error message or log. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1***@');
}
