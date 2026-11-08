import { eq, sql } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  migrationsFolder,
  pgSchema,
  schema,
  type DatabaseHandle,
} from './index.js';

/**
 * Runs the shipped migrations for each dialect. SQLite always runs (in memory);
 * PostgreSQL runs when TEST_POSTGRES_URL points at a throwaway database
 * (CI provides a service container). That database is wiped first.
 */
const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

const EXPECTED_TABLES = [
  'api_tokens',
  'content',
  'content_meta',
  'jobs',
  'media',
  'options',
  'plugins',
  'revisions',
  'sessions',
  'term_relations',
  'terms',
  'users',
];

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('createDatabase', () => {
  it('picks SQLite for file:/:memory: URLs', async () => {
    handle = createDatabase({ url: ':memory:' });
    expect(handle.dialect).toBe('sqlite');
    expect(await handle.ping()).toBe(true);
  });

  it('picks PostgreSQL for postgres:// URLs without connecting yet', async () => {
    handle = createDatabase({ url: 'postgres://nobody@127.0.0.1:1/none' });
    expect(handle.dialect).toBe('postgres');
  });

  it('rejects unsupported URLs', () => {
    expect(() => createDatabase({ url: 'mysql://localhost/db' })).toThrow(/Unsupported/);
  });

  it('ships a migrations folder per dialect', () => {
    expect(existsSync(migrationsFolder('sqlite'))).toBe(true);
    expect(existsSync(migrationsFolder('postgres'))).toBe(true);
  });
});

describe('SQLite migrations', () => {
  it('create the v1 schema and round-trip a row', async () => {
    const h = createDatabase({ url: ':memory:' });
    handle = h;
    if (h.dialect !== 'sqlite') throw new Error('expected sqlite');
    await h.migrate();
    await h.migrate(); // idempotent

    const rows = await h.db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name not like '%sqlite%' and name not like '__drizzle%'`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(EXPECTED_TABLES);

    const [user] = await h.db
      .insert(schema.users)
      .values({ email: 'a@example.com', passwordHash: 'x', displayName: 'A' })
      .returning();
    expect(user?.role).toBe('subscriber');
    expect(user?.createdAt).toBeInstanceOf(Date);

    await h.db.insert(schema.content).values({ type: 'post', slug: 'hello', authorId: user!.id });
    const [post] = await h.db.select().from(schema.content).where(eq(schema.content.slug, 'hello'));
    expect(post?.body).toEqual([]);
    expect(post?.status).toBe('draft');
  });
});

describe.skipIf(!POSTGRES_URL)('PostgreSQL migrations', () => {
  it('create the v1 schema and round-trip a row', async () => {
    const h = createDatabase({ url: POSTGRES_URL! });
    handle = h;
    if (h.dialect !== 'postgres') throw new Error('expected postgres');
    expect(await h.ping()).toBe(true);

    await h.db.execute(sql`drop schema if exists drizzle cascade`);
    await h.db.execute(sql`drop schema public cascade`);
    await h.db.execute(sql`create schema public`);

    await h.migrate();
    await h.migrate(); // idempotent

    const tables = await h.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect([...tables].map((r) => r.table_name)).toEqual(EXPECTED_TABLES);

    const [user] = await h.db
      .insert(pgSchema.users)
      .values({ email: 'a@example.com', passwordHash: 'x', displayName: 'A' })
      .returning();
    expect(user?.role).toBe('subscriber');
    expect(user?.createdAt).toBeInstanceOf(Date);

    await h.db.insert(pgSchema.content).values({ type: 'post', slug: 'hello', authorId: user!.id });
    const [post] = await h.db
      .select()
      .from(pgSchema.content)
      .where(eq(pgSchema.content.slug, 'hello'));
    expect(post?.body).toEqual([]);
    expect(post?.status).toBe('draft');

    await expect(
      h.db.insert(pgSchema.content).values({ type: 'post', slug: 'hello' }),
    ).rejects.toThrow();
  });
});
