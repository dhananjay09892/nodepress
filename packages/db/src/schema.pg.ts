import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { Block, ContentStatus, Role } from './schema.js';

/**
 * NodePress schema v1, PostgreSQL dialect.
 *
 * Same tables, columns, keys and indexes as the SQLite schema in `schema.ts`
 * (checked by `schema-parity.test.ts`), using native Postgres types:
 * identity ids, `timestamptz`, `jsonb` and `boolean`. Row types match the
 * SQLite ones, so services see the same shapes on either dialect.
 */

const ts = (name: string) => timestamp(name, { mode: 'date', withTimezone: true, precision: 3 });
const id = () => integer('id').primaryKey().generatedByDefaultAsIdentity();

const timestamps = {
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role').$type<Role>().notNull().default('subscriber'),
  ...timestamps,
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const apiTokens = pgTable('api_tokens', {
  id: id(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  lastUsedAt: ts('last_used_at'),
  expiresAt: ts('expires_at'),
  createdAt: timestamps.createdAt,
});

export const content = pgTable(
  'content',
  {
    id: id(),
    /** "post", "page", or a custom type registered by a plugin. */
    type: text('type').notNull(),
    status: text('status').$type<ContentStatus>().notNull().default('draft'),
    title: text('title').notNull().default(''),
    slug: text('slug').notNull(),
    body: jsonb('body')
      .$type<Block[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    excerpt: text('excerpt'),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    parentId: integer('parent_id').references((): AnyPgColumn => content.id, {
      onDelete: 'set null',
    }),
    publishedAt: ts('published_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('content_type_slug_idx').on(t.type, t.slug),
    index('content_type_status_published_idx').on(t.type, t.status, t.publishedAt),
  ],
);

export const contentMeta = pgTable(
  'content_meta',
  {
    contentId: integer('content_id')
      .notNull()
      .references(() => content.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value'),
  },
  (t) => [primaryKey({ columns: [t.contentId, t.key] })],
);

export const revisions = pgTable(
  'revisions',
  {
    id: id(),
    contentId: integer('content_id')
      .notNull()
      .references(() => content.id, { onDelete: 'cascade' }),
    snapshot: jsonb('snapshot').notNull(),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('revisions_content_idx').on(t.contentId)],
);

export const terms = pgTable(
  'terms',
  {
    id: id(),
    /** "category", "tag", or a custom taxonomy. */
    taxonomy: text('taxonomy').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    parentId: integer('parent_id').references((): AnyPgColumn => terms.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [uniqueIndex('terms_taxonomy_slug_idx').on(t.taxonomy, t.slug)],
);

export const termRelations = pgTable(
  'term_relations',
  {
    contentId: integer('content_id')
      .notNull()
      .references(() => content.id, { onDelete: 'cascade' }),
    termId: integer('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.contentId, t.termId] })],
);

export const media = pgTable('media', {
  id: id(),
  path: text('path').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  alt: text('alt').notNull().default(''),
  /** Resized variants, e.g. { thumbnail: "uploads/2026/11/cat-150.webp" }. */
  variants: jsonb('variants')
    .$type<Record<string, string>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  uploadedBy: integer('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamps.createdAt,
});

export const options = pgTable('options', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
  /** Load on every request (site name, permalinks…) vs. only when asked. */
  autoload: boolean('autoload').notNull().default(true),
});

export const plugins = pgTable('plugins', {
  name: text('name').primaryKey(),
  version: text('version').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  settings: jsonb('settings')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
});

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    type: text('type').notNull(),
    payload: jsonb('payload'),
    runAt: ts('run_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    status: text('status')
      .$type<'pending' | 'running' | 'done' | 'failed'>()
      .notNull()
      .default('pending'),
    lastError: text('last_error'),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('jobs_status_run_at_idx').on(t.status, t.runAt)],
);
