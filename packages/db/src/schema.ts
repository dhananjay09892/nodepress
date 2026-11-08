import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

/**
 * NodePress schema v1 (SQLite dialect — the zero-config default).
 * A PostgreSQL/MySQL variant with the same shape will follow.
 */

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdate(() => new Date()),
};

export type Role = 'administrator' | 'editor' | 'author' | 'contributor' | 'subscriber';
export type ContentStatus = 'draft' | 'scheduled' | 'published' | 'private' | 'trash';

/** Content body is stored as editor blocks (JSON). */
export interface Block {
  type: string;
  attrs?: Record<string, unknown>;
  children?: Block[];
  text?: string;
}

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role').$type<Role>().notNull().default('subscriber'),
  ...timestamps,
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const apiTokens = sqliteTable('api_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  createdAt: timestamps.createdAt,
});

export const content = sqliteTable(
  'content',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** "post", "page", or a custom type registered by a plugin. */
    type: text('type').notNull(),
    status: text('status').$type<ContentStatus>().notNull().default('draft'),
    title: text('title').notNull().default(''),
    slug: text('slug').notNull(),
    body: text('body', { mode: 'json' }).$type<Block[]>().notNull().default(sql`'[]'`),
    excerpt: text('excerpt'),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    parentId: integer('parent_id').references((): AnySQLiteColumn => content.id, {
      onDelete: 'set null',
    }),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('content_type_slug_idx').on(t.type, t.slug),
    index('content_type_status_published_idx').on(t.type, t.status, t.publishedAt),
  ],
);

export const contentMeta = sqliteTable(
  'content_meta',
  {
    contentId: integer('content_id')
      .notNull()
      .references(() => content.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }),
  },
  (t) => [primaryKey({ columns: [t.contentId, t.key] })],
);

export const revisions = sqliteTable(
  'revisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contentId: integer('content_id')
      .notNull()
      .references(() => content.id, { onDelete: 'cascade' }),
    snapshot: text('snapshot', { mode: 'json' }).notNull(),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('revisions_content_idx').on(t.contentId)],
);

export const terms = sqliteTable(
  'terms',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** "category", "tag", or a custom taxonomy. */
    taxonomy: text('taxonomy').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    parentId: integer('parent_id').references((): AnySQLiteColumn => terms.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [uniqueIndex('terms_taxonomy_slug_idx').on(t.taxonomy, t.slug)],
);

export const termRelations = sqliteTable(
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

export const media = sqliteTable('media', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  path: text('path').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  alt: text('alt').notNull().default(''),
  /** Resized variants, e.g. { thumbnail: "uploads/2026/11/cat-150.webp" }. */
  variants: text('variants', { mode: 'json' })
    .$type<Record<string, string>>()
    .notNull()
    .default(sql`'{}'`),
  uploadedBy: integer('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamps.createdAt,
});

export const options = sqliteTable('options', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }),
  /** Load on every request (site name, permalinks…) vs. only when asked. */
  autoload: integer('autoload', { mode: 'boolean' }).notNull().default(true),
});

export const plugins = sqliteTable('plugins', {
  name: text('name').primaryKey(),
  version: text('version').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  settings: text('settings', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
});

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }),
    runAt: integer('run_at', { mode: 'timestamp_ms' }).notNull(),
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
