import type { HookRegistry } from './hooks.js';
import { silentLogger, type Logger } from './logger.js';

export const CONTENT_STATUSES = ['draft', 'scheduled', 'published', 'private', 'trash'] as const;
export type ContentStatusName = (typeof CONTENT_STATUSES)[number];

export const MAX_TITLE_LENGTH = 500;
export const MAX_SLUG_LENGTH = 190;
export const MAX_EXCERPT_LENGTH = 5000;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

/** A block of editor content (the body of a post is an array of these). */
export interface ContentBlock {
  type: string;
  attrs?: Record<string, unknown>;
  children?: ContentBlock[];
  text?: string;
}

/** A content item as stored. */
export interface ContentRecord {
  id: number;
  type: string;
  status: string;
  title: string;
  slug: string;
  body: ContentBlock[];
  excerpt: string | null;
  authorId: number | null;
  parentId: number | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type Content = ContentRecord;

/** The editable fields of a content item: what the `post:saving` filter can change. */
export interface ContentFields {
  title: string;
  slug: string;
  status: ContentStatusName;
  body: ContentBlock[];
  excerpt: string | null;
  authorId: number | null;
  parentId: number | null;
  publishedAt: Date | null;
}

export interface NewContentRecord extends Omit<ContentFields, 'status'> {
  type: string;
  status: string;
}

export type ContentPatchRecord = Partial<Omit<NewContentRecord, 'type'>>;

export interface ContentRecordQuery {
  type?: string;
  statuses?: string[];
  authorId?: number;
  limit: number;
  offset: number;
}

/** What a revision stores: the editable fields as they were saved. */
export interface ContentSnapshot {
  title: string;
  slug: string;
  status: string;
  body: ContentBlock[];
  excerpt: string | null;
  authorId: number | null;
  parentId: number | null;
  /** ISO 8601 timestamp. */
  publishedAt: string | null;
}

export interface RevisionRecord {
  id: number;
  contentId: number;
  snapshot: unknown;
  authorId: number | null;
  createdAt: Date;
}

export interface Revision {
  id: number;
  contentId: number;
  snapshot: ContentSnapshot;
  authorId: number | null;
  createdAt: Date;
}

/** Storage behind the content service. `@nodepress/db` provides `createContentStore()`. */
export interface ContentStore {
  insert(row: NewContentRecord): Promise<ContentRecord>;
  findById(id: number): Promise<ContentRecord | undefined>;
  findBySlug(type: string, slug: string): Promise<ContentRecord | undefined>;
  /** True if another item of this type already uses the slug (ignoring `excludeId`). */
  slugExists(type: string, slug: string, excludeId?: number): Promise<boolean>;
  update(id: number, patch: ContentPatchRecord): Promise<ContentRecord | undefined>;
  delete(id: number): Promise<boolean>;
  /** Newest first. */
  list(query: ContentRecordQuery): Promise<ContentRecord[]>;
  insertRevision(row: {
    contentId: number;
    snapshot: unknown;
    authorId: number | null;
  }): Promise<RevisionRecord>;
  /** Newest first. */
  listRevisions(contentId: number): Promise<RevisionRecord[]>;
  findRevision(id: number): Promise<RevisionRecord | undefined>;
}

/** Why a `post:saving` filter is being run. */
export interface ContentSavingContext {
  type: string;
  isNew: boolean;
  /** Present when updating. */
  id?: number;
  /** The stored item before this update. Present when updating. */
  previous?: ContentRecord;
}

declare module './hooks.js' {
  interface ActionMap {
    /** After every successful create or update. */
    'post:saved': [content: Content, info: { isNew: boolean; previous?: Content }];
    /** When an item becomes published (created as published, or moved to published). */
    'post:published': [content: Content];
    'post:trashed': [content: Content];
    'post:deleted': [content: Content];
  }
  interface FilterMap {
    /**
     * Change the fields about to be saved. The result is re-validated; if a listener returns
     * something invalid the unfiltered fields are saved instead.
     */
    'post:saving': { value: ContentFields; context: ContentSavingContext };
  }
}

export interface ContentServiceOptions {
  store: ContentStore;
  hooks: HookRegistry;
  logger?: Logger;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/** Who is making the change; recorded as the revision author. */
export interface ContentActor {
  userId?: number | null;
}

export interface CreateContentInput {
  type: string;
  title?: string;
  /** Generated from the title when omitted. Always made unique within the type. */
  slug?: string;
  status?: ContentStatusName;
  body?: ContentBlock[];
  excerpt?: string | null;
  /** Defaults to the acting user. */
  authorId?: number | null;
  parentId?: number | null;
  /** Required (in the future) for `scheduled`; defaults to now for `published`. */
  publishedAt?: Date | null;
}

export type UpdateContentInput = Partial<Omit<CreateContentInput, 'type'>>;

export interface ListContentOptions {
  type?: string;
  /** Defaults to every status except `trash`. */
  status?: ContentStatusName | ContentStatusName[];
  authorId?: number;
  limit?: number;
  offset?: number;
}

export class ContentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentValidationError';
  }
}

export class ContentNotFoundError extends Error {
  constructor(id: number) {
    super(`Content ${id} does not exist`);
    this.name = 'ContentNotFoundError';
  }
}

const TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,49}$/;

/** Lower-case ASCII slug: accents folded, anything else collapsed to single hyphens. */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH - 10)
    .replace(/-+$/g, '');
  return slug;
}

function isBlock(value: unknown, depth = 0): value is ContentBlock {
  if (depth > 50 || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const b = value as Record<string, unknown>;
  if (typeof b.type !== 'string' || b.type.length === 0) return false;
  if (b.text !== undefined && typeof b.text !== 'string') return false;
  if (b.attrs !== undefined && (typeof b.attrs !== 'object' || b.attrs === null)) return false;
  if (b.children !== undefined) {
    if (!Array.isArray(b.children)) return false;
    return b.children.every((c) => isBlock(c, depth + 1));
  }
  return true;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function sameFields(a: ContentFields, b: ContentFields): boolean {
  return (
    a.title === b.title &&
    a.slug === b.slug &&
    a.status === b.status &&
    a.excerpt === b.excerpt &&
    a.authorId === b.authorId &&
    a.parentId === b.parentId &&
    sameInstant(a.publishedAt, b.publishedAt) &&
    JSON.stringify(a.body) === JSON.stringify(b.body)
  );
}

function fieldsOf(record: ContentRecord): ContentFields {
  return {
    title: record.title,
    slug: record.slug,
    status: record.status as ContentStatusName,
    body: record.body,
    excerpt: record.excerpt,
    authorId: record.authorId,
    parentId: record.parentId,
    publishedAt: record.publishedAt,
  };
}

function snapshotOf(record: ContentRecord): ContentSnapshot {
  return {
    title: record.title,
    slug: record.slug,
    status: record.status,
    body: record.body,
    excerpt: record.excerpt,
    authorId: record.authorId,
    parentId: record.parentId,
    publishedAt: record.publishedAt ? record.publishedAt.toISOString() : null,
  };
}

function toRevision(record: RevisionRecord): Revision {
  return { ...record, snapshot: record.snapshot as ContentSnapshot };
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export class ContentService {
  readonly #store: ContentStore;
  readonly #hooks: HookRegistry;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: ContentServiceOptions) {
    this.#store = options.store;
    this.#hooks = options.hooks;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? (() => new Date());
  }

  // ── Reads ────────────────────────────────────────────────────────────

  async get(id: number): Promise<Content | undefined> {
    if (!isId(id)) return undefined;
    return this.#store.findById(id);
  }

  async getBySlug(type: string, slug: string): Promise<Content | undefined> {
    return this.#store.findBySlug(type, slug);
  }

  async list(options: ListContentOptions = {}): Promise<Content[]> {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new ContentValidationError(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ContentValidationError('offset must be a non-negative integer');
    }
    const requested =
      options.status === undefined
        ? CONTENT_STATUSES.filter((s) => s !== 'trash')
        : Array.isArray(options.status)
          ? options.status
          : [options.status];
    for (const status of requested) this.#assertStatus(status);
    const query: ContentRecordQuery = { statuses: [...requested], limit, offset };
    if (options.type !== undefined) query.type = options.type;
    if (options.authorId !== undefined) query.authorId = options.authorId;
    return this.#store.list(query);
  }

  async listRevisions(contentId: number): Promise<Revision[]> {
    return (await this.#store.listRevisions(contentId)).map(toRevision);
  }

  async getRevision(id: number): Promise<Revision | undefined> {
    const record = await this.#store.findRevision(id);
    return record ? toRevision(record) : undefined;
  }

  // ── Writes ───────────────────────────────────────────────────────────

  async create(input: CreateContentInput, actor: ContentActor = {}): Promise<Content> {
    if (typeof input.type !== 'string' || !TYPE_PATTERN.test(input.type)) {
      throw new ContentValidationError(
        'type must be lower-case letters, digits, "-" or "_", starting with a letter (max 50)',
      );
    }
    const type = input.type;
    const initial: ContentFields = {
      title: input.title ?? '',
      slug: input.slug ?? '',
      status: input.status ?? 'draft',
      body: input.body ?? [],
      excerpt: input.excerpt ?? null,
      authorId: input.authorId ?? actor.userId ?? null,
      parentId: input.parentId ?? null,
      publishedAt: input.publishedAt ?? null,
    };
    const context: ContentSavingContext = { type, isNew: true };
    const fields = await this.#prepare(initial, type, context);

    const row = await this.#insertUnique(type, fields);
    await this.#store.insertRevision({
      contentId: row.id,
      snapshot: snapshotOf(row),
      authorId: actor.userId ?? row.authorId,
    });
    await this.#emitSaved(row, { isNew: true });
    return row;
  }

  async update(id: number, input: UpdateContentInput, actor: ContentActor = {}): Promise<Content> {
    const previous = await this.get(id);
    if (!previous) throw new ContentNotFoundError(id);

    const merged: ContentFields = {
      ...fieldsOf(previous),
      ...(input.title !== undefined && { title: input.title }),
      ...(input.slug !== undefined && { slug: input.slug }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.body !== undefined && { body: input.body }),
      ...(input.excerpt !== undefined && { excerpt: input.excerpt }),
      ...(input.authorId !== undefined && { authorId: input.authorId }),
      ...(input.parentId !== undefined && { parentId: input.parentId }),
      ...(input.publishedAt !== undefined && { publishedAt: input.publishedAt }),
    };
    const context: ContentSavingContext = { type: previous.type, isNew: false, id, previous };
    const fields = await this.#prepare(merged, previous.type, context, previous);

    if (sameFields(fields, fieldsOf(previous))) return previous;

    const slugChanged = fields.slug !== previous.slug;
    const patch: ContentPatchRecord = { ...fields };
    if (!slugChanged) delete patch.slug;
    const row = await this.#updateUnique(previous, patch, slugChanged);

    await this.#store.insertRevision({
      contentId: row.id,
      snapshot: snapshotOf(row),
      authorId: actor.userId ?? row.authorId,
    });
    await this.#emitSaved(row, { isNew: false, previous });
    return row;
  }

  /** Move an item to the trash. Restore it with `restore()`. */
  async trash(id: number, actor: ContentActor = {}): Promise<Content> {
    const row = await this.update(id, { status: 'trash' }, actor);
    await this.#hooks.doAction('post:trashed', row);
    return row;
  }

  /** Bring an item back from the trash as a draft. Other items are returned unchanged. */
  async restore(id: number, actor: ContentActor = {}): Promise<Content> {
    const current = await this.get(id);
    if (!current) throw new ContentNotFoundError(id);
    if (current.status !== 'trash') return current;
    return this.update(id, { status: 'draft' }, actor);
  }

  /** Permanently delete an item and its revisions. */
  async delete(id: number): Promise<boolean> {
    const current = await this.get(id);
    if (!current) return false;
    const removed = await this.#store.delete(id);
    if (removed) await this.#hooks.doAction('post:deleted', current);
    return removed;
  }

  // ── Internals ────────────────────────────────────────────────────────

  #assertStatus(status: unknown): asserts status is ContentStatusName {
    if (!CONTENT_STATUSES.includes(status as ContentStatusName)) {
      throw new ContentValidationError(`status must be one of ${CONTENT_STATUSES.join(', ')}`);
    }
  }

  /**
   * Validate the caller's fields, run `post:saving`, and validate the result again. A listener
   * that returns something invalid is ignored rather than failing the save.
   */
  async #prepare(
    initial: ContentFields,
    type: string,
    context: ContentSavingContext,
    previous?: ContentRecord,
  ): Promise<ContentFields> {
    const checked = await this.#finalize(initial, type, previous);
    const filtered = await this.#hooks.applyFilters('post:saving', { ...checked }, context);
    try {
      return await this.#finalize({ ...checked, ...filtered }, type, previous);
    } catch (error) {
      this.#logger.warn('Ignoring invalid result from a "post:saving" listener', {
        error: error instanceof Error ? error.message : String(error),
      });
      return checked;
    }
  }

  /** Validate every field, apply the status/date rules and normalise the slug text. */
  async #finalize(
    input: ContentFields,
    type: string,
    previous?: ContentRecord,
  ): Promise<ContentFields> {
    const f: ContentFields = { ...input };
    if (typeof f.title !== 'string' || f.title.length > MAX_TITLE_LENGTH) {
      throw new ContentValidationError(`title must be a string of at most ${MAX_TITLE_LENGTH}`);
    }
    f.title = f.title.trim();
    if (typeof f.slug !== 'string') throw new ContentValidationError('slug must be a string');
    f.slug = f.slug === (previous?.slug ?? undefined) ? f.slug : slugify(f.slug);
    this.#assertStatus(f.status);
    if (!Array.isArray(f.body) || !f.body.every((b) => isBlock(b))) {
      throw new ContentValidationError('body must be an array of blocks ({ type, ... })');
    }
    if (
      f.excerpt !== null &&
      (typeof f.excerpt !== 'string' || f.excerpt.length > MAX_EXCERPT_LENGTH)
    ) {
      throw new ContentValidationError(
        `excerpt must be null or a string of at most ${MAX_EXCERPT_LENGTH}`,
      );
    }
    if (f.authorId !== null && !isId(f.authorId)) {
      throw new ContentValidationError('authorId must be null or a positive integer');
    }
    if (f.publishedAt !== null) {
      if (!(f.publishedAt instanceof Date) || Number.isNaN(f.publishedAt.getTime())) {
        throw new ContentValidationError('publishedAt must be null or a valid date');
      }
    }

    const now = this.#now();
    if (f.status === 'scheduled') {
      if (f.publishedAt === null || f.publishedAt.getTime() <= now.getTime()) {
        throw new ContentValidationError('a scheduled item needs a publishedAt in the future');
      }
    } else if (f.status === 'published') {
      if (f.publishedAt === null || f.publishedAt.getTime() > now.getTime()) f.publishedAt = now;
    }

    await this.#assertParent(f.parentId, type, previous?.id);
    return f;
  }

  async #assertParent(parentId: number | null, type: string, selfId?: number): Promise<void> {
    if (parentId === null) return;
    if (!isId(parentId)) {
      throw new ContentValidationError('parentId must be null or a positive integer');
    }
    if (parentId === selfId) throw new ContentValidationError('an item cannot be its own parent');
    const seen = new Set<number>();
    let cursor: number | null = parentId;
    let first = true;
    while (cursor !== null) {
      if (cursor === selfId) throw new ContentValidationError('parentId would create a cycle');
      if (seen.has(cursor)) break; // a pre-existing cycle that does not involve this item
      seen.add(cursor);
      const parent: ContentRecord | undefined = await this.#store.findById(cursor);
      if (!parent) {
        if (first) throw new ContentValidationError(`parent ${parentId} does not exist`);
        break;
      }
      if (first && parent.type !== type) {
        throw new ContentValidationError('parent must have the same content type');
      }
      first = false;
      cursor = parent.parentId;
    }
  }

  /** `base`, `base-2`, `base-3`… the first one no other item of the type uses. */
  async #uniqueSlug(type: string, wanted: string, title: string, excludeId?: number) {
    const base = wanted || slugify(title) || 'untitled';
    let candidate = base;
    for (let n = 2; n < 1000; n++) {
      if (!(await this.#store.slugExists(type, candidate, excludeId))) return candidate;
      candidate = `${base}-${n}`;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  async #insertUnique(type: string, fields: ContentFields): Promise<ContentRecord> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = await this.#uniqueSlug(type, fields.slug, fields.title);
      try {
        return await this.#store.insert({ ...fields, type, slug });
      } catch (error) {
        // Another request may have taken the slug between the check and the insert.
        lastError = error;
        if (!(await this.#store.slugExists(type, slug))) break;
      }
    }
    throw lastError;
  }

  async #updateUnique(
    previous: ContentRecord,
    patch: ContentPatchRecord,
    slugChanged: boolean,
  ): Promise<ContentRecord> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = { ...patch };
      if (slugChanged) {
        next.slug = await this.#uniqueSlug(
          previous.type,
          patch.slug ?? '',
          patch.title ?? previous.title,
          previous.id,
        );
      }
      try {
        const row = await this.#store.update(previous.id, next);
        if (!row) throw new ContentNotFoundError(previous.id);
        return row;
      } catch (error) {
        lastError = error;
        if (!slugChanged || !next.slug) break;
        if (!(await this.#store.slugExists(previous.type, next.slug, previous.id))) break;
      }
    }
    throw lastError;
  }

  async #emitSaved(row: ContentRecord, info: { isNew: boolean; previous?: ContentRecord }) {
    await this.#hooks.doAction('post:saved', row, info);
    if (row.status === 'published' && (info.isNew || info.previous?.status !== 'published')) {
      await this.#hooks.doAction('post:published', row);
    }
  }
}

export function createContentService(options: ContentServiceOptions): ContentService {
  return new ContentService(options);
}
