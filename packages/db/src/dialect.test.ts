import { describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_URL, detectDialect, migrationsSubdir, redactUrl } from './dialect.js';

describe('detectDialect', () => {
  it.each([
    ['postgres://user:pass@localhost:5432/nodepress', 'postgres'],
    ['postgresql://localhost/nodepress', 'postgres'],
    ['POSTGRES://localhost/nodepress', 'postgres'],
    ['  postgres://localhost/nodepress  ', 'postgres'],
    ['file:./nodepress.db', 'sqlite'],
    ['file:/var/lib/nodepress/site.db', 'sqlite'],
    [':memory:', 'sqlite'],
    ['libsql://my-site.turso.io', 'sqlite'],
    ['https://my-site.turso.io', 'sqlite'],
    ['wss://my-site.turso.io', 'sqlite'],
  ] as const)('%s → %s', (url, dialect) => {
    expect(detectDialect(url)).toBe(dialect);
  });

  it('defaults to a local SQLite file', () => {
    expect(detectDialect(DEFAULT_DATABASE_URL)).toBe('sqlite');
  });

  it.each(['mysql://localhost/nodepress', './nodepress.db', 'nodepress.db', ''])(
    'rejects %j',
    (url) => {
      expect(() => detectDialect(url)).toThrow(/Unsupported database URL/);
    },
  );

  it('does not leak credentials in the error message', () => {
    expect(() => detectDialect('mysql://admin:s3cret@db/site')).toThrow(/mysql:\/\/\*\*\*@db/);
    expect(() => detectDialect('mysql://admin:s3cret@db/site')).not.toThrow(/s3cret/);
  });
});

describe('migrationsSubdir', () => {
  it('keeps one migration folder per dialect', () => {
    expect(migrationsSubdir('sqlite')).toBe('drizzle/sqlite');
    expect(migrationsSubdir('postgres')).toBe('drizzle/postgres');
  });
});

describe('redactUrl', () => {
  it('leaves URLs without credentials untouched', () => {
    expect(redactUrl('postgres://localhost/db')).toBe('postgres://localhost/db');
    expect(redactUrl('file:./x.db')).toBe('file:./x.db');
  });
});
