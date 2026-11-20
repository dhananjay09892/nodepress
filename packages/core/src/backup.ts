import { z } from 'zod';
import type { ContentService, Content, ContentStatusName } from './content.js';
import { CONTENT_STATUSES } from './content.js';
import { silentLogger, type Logger } from './logger.js';
import type { SettingsService } from './settings.js';
import type { TaxonomyService } from './taxonomies.js';

export const EXPORT_FORMAT = 'nodepress-export';
export const EXPORT_VERSION = 1;
export const MAX_EXPORT_ITEMS = 100_000;
export const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const PAGE = 100;

export interface ExportedTerm {
  id: number;
  taxonomy: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: number | null;
}

export interface ExportedContent {
  id: number;
  type: string;
  status: ContentStatusName;
  title: string;
  slug: string;
  body: unknown[];
  excerpt: string | null;
  authorId: number | null;
  parentId: number | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Custom field values (what the content API returns as `meta`). */
  meta: Record<string, unknown>;
  /** Taxonomy name → slugs of the terms the item has. */
  terms: Record<string, string[]>;
}

/** What `exportSite` produces and `importSite` reads. Plain JSON, no secrets, no users. */
export interface SiteExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  settings: Record<string, unknown>;
  terms: ExportedTerm[];
  content: ExportedContent[];
  /** Who wrote the items: for matching authors when importing. Never includes passwords. */
  authors: Array<{ id: number; email: string; displayName: string }>;
}

export interface BackupDeps {
  content: Pick<ContentService, 'list' | 'create' | 'update'>;
  taxonomies: Pick<
    TaxonomyService,
    | 'listTaxonomies'
    | 'listTerms'
    | 'createTerm'
    | 'getTermBySlug'
    | 'getContentTerms'
    | 'setContentTerms'
  >;
  settings: Pick<SettingsService, 'getAll' | 'update'>;
  meta?: {
    getMetaMany(ids: number[]): Promise<Map<number, Record<string, unknown>>>;
    setMeta(contentId: number, values: Record<string, unknown>): Promise<void>;
  };
  /** Users, only to name the authors in an export. */
  users?: { list(): Promise<Array<{ id: number; email: string; displayName: string }>> };
  logger?: Logger;
  now?: () => Date;
}

/** The whole site's content, terms and settings as one JSON-friendly object. Trashed items are included. */
export async function exportSite(deps: BackupDeps): Promise<SiteExport> {
  const now = deps.now ?? (() => new Date());
  const terms: ExportedTerm[] = [];
  for (const taxonomy of deps.taxonomies.listTaxonomies()) {
    for (const term of await deps.taxonomies.listTerms(taxonomy.name)) {
      terms.push({
        id: term.id,
        taxonomy: term.taxonomy,
        name: term.name,
        slug: term.slug,
        description: term.description,
        parentId: term.parentId,
      });
    }
  }

  const items: Content[] = [];
  for (let offset = 0; items.length < MAX_EXPORT_ITEMS; offset += PAGE) {
    const batch = await deps.content.list({
      status: [...CONTENT_STATUSES],
      orderBy: 'id',
      direction: 'asc',
      limit: PAGE,
      offset,
    });
    items.push(...batch);
    if (batch.length < PAGE) break;
  }

  const metas = deps.meta
    ? await deps.meta.getMetaMany(items.map((i) => i.id))
    : new Map<number, Record<string, unknown>>();
  const content: ExportedContent[] = [];
  for (const item of items) {
    const assigned: Record<string, string[]> = {};
    for (const term of await deps.taxonomies.getContentTerms(item.id)) {
      (assigned[term.taxonomy] ??= []).push(term.slug);
    }
    content.push({
      id: item.id,
      type: item.type,
      status: item.status as ContentStatusName,
      title: item.title,
      slug: item.slug,
      body: item.body as unknown[],
      excerpt: item.excerpt,
      authorId: item.authorId,
      parentId: item.parentId,
      publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      meta: metas.get(item.id) ?? {},
      terms: assigned,
    });
  }

  const wanted = new Set(content.map((c) => c.authorId).filter((id): id is number => id !== null));
  const authors = deps.users
    ? (await deps.users.list())
        .filter((u) => wanted.has(u.id))
        .map((u) => ({ id: u.id, email: u.email, displayName: u.displayName }))
    : [];

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now().toISOString(),
    settings: { ...(await deps.settings.getAll()) },
    terms,
    content,
    authors,
  };
}

const text = (max: number) => z.string().max(max);
const exportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string().max(40),
  settings: z.record(z.string(), z.unknown()),
  terms: z
    .array(
      z.object({
        id: z.number().int(),
        taxonomy: text(100).min(1),
        name: text(200).min(1),
        slug: text(200).min(1),
        description: text(5000).nullable(),
        parentId: z.number().int().nullable(),
      }),
    )
    .max(MAX_EXPORT_ITEMS),
  content: z
    .array(
      z.object({
        id: z.number().int(),
        type: text(100).min(1),
        status: z.enum(CONTENT_STATUSES),
        title: text(1000),
        slug: text(300),
        body: z.array(z.unknown()),
        excerpt: text(20000).nullable(),
        authorId: z.number().int().nullable(),
        parentId: z.number().int().nullable(),
        publishedAt: text(40).nullable(),
        createdAt: text(40),
        updatedAt: text(40),
        meta: z.record(z.string(), z.unknown()),
        terms: z.record(z.string(), z.array(text(200))),
      }),
    )
    .max(MAX_EXPORT_ITEMS),
  authors: z.array(z.object({ id: z.number().int(), email: text(254), displayName: text(200) })),
});

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface ImportOptions {
  /** NodePress user for an item whose author is matched by email in the export; otherwise `defaultAuthorId`. */
  resolveAuthor?: (author: { email: string; displayName: string }) => Promise<number | null>;
  defaultAuthorId?: number | null;
  /** Custom field names to leave out (for example `featured_image` while media is not restored). */
  skipMeta?: string[];
}

export interface ImportSummary {
  terms: number;
  content: number;
  /** Old content id → new content id. */
  idMap: Record<string, number>;
  settingsApplied: string[];
  skipped: Array<{ id: number; title: string; reason: string }>;
  warnings: string[];
}

/** Settings that are applied from a backup. `front_page_id` is mapped to the new id. */
const SETTINGS_TO_RESTORE = [
  'site_title',
  'tagline',
  'timezone',
  'posts_per_page',
  'discourage_search_engines',
  'permalink_structure',
  'api_public_read',
] as const;

/**
 * Read a site export back in. Everything is validated first (a bad file changes nothing); then
 * terms (parents first), content (parents first, new ids), custom fields, term assignments and
 * settings are written. An item that cannot be created is skipped and reported, and the rest go on.
 * Existing content is never changed or deleted: items are added next to it (slugs stay unique).
 */
export async function importSite(
  data: unknown,
  deps: BackupDeps,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const logger = deps.logger ?? silentLogger;
  const parsed = exportSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BackupError(
      `This is not a NodePress export${issue ? ` (${issue.path.join('.') || 'file'}: ${issue.message})` : ''}.`,
    );
  }
  const file = parsed.data;
  const summary: ImportSummary = {
    terms: 0,
    content: 0,
    idMap: {},
    settingsApplied: [],
    skipped: [],
    warnings: [],
  };

  // Terms, parents first. A term that already exists (same taxonomy and slug) is reused.
  const termIds = new Map<number, number>();
  const pending = [...file.terms];
  const taxonomyNames = new Set(deps.taxonomies.listTaxonomies().map((t) => t.name));
  for (let round = 0; pending.length > 0 && round < 50; round++) {
    const next: typeof pending = [];
    for (const term of pending) {
      if (!taxonomyNames.has(term.taxonomy)) {
        summary.warnings.push(
          `Taxonomy "${term.taxonomy}" does not exist here; term "${term.name}" skipped.`,
        );
        continue;
      }
      if (term.parentId !== null && !termIds.has(term.parentId)) {
        if (file.terms.some((t) => t.id === term.parentId)) next.push(term);
        continue;
      }
      try {
        const existing = await deps.taxonomies.getTermBySlug(term.taxonomy, term.slug);
        const created =
          existing ??
          (await deps.taxonomies.createTerm({
            taxonomy: term.taxonomy,
            name: term.name,
            slug: term.slug,
            description: term.description,
            parentId: term.parentId === null ? null : (termIds.get(term.parentId) ?? null),
          }));
        termIds.set(term.id, created.id);
        if (!existing) summary.terms++;
      } catch (error) {
        summary.warnings.push(`Term "${term.name}" skipped: ${errorText(error)}`);
      }
    }
    if (next.length === pending.length) break;
    pending.splice(0, pending.length, ...next);
  }

  // Content, parents before children.
  const authorEmails = new Map(file.authors.map((a) => [a.id, a]));
  const authorCache = new Map<number, number | null>();
  const ordered = orderParentsFirst(file.content);
  const skipMeta = new Set(options.skipMeta ?? []);
  for (const item of ordered) {
    try {
      let authorId = options.defaultAuthorId ?? null;
      if (item.authorId !== null && options.resolveAuthor) {
        if (!authorCache.has(item.authorId)) {
          const author = authorEmails.get(item.authorId);
          authorCache.set(
            item.authorId,
            author
              ? await options.resolveAuthor({
                  email: author.email,
                  displayName: author.displayName,
                })
              : null,
          );
        }
        authorId = authorCache.get(item.authorId) ?? authorId;
      }
      const parentId =
        item.parentId === null ? null : (summary.idMap[String(item.parentId)] ?? null);
      const created = await deps.content.create(
        {
          type: item.type,
          title: item.title,
          slug: item.slug,
          status: item.status,
          body: item.body as never,
          excerpt: item.excerpt,
          authorId,
          parentId,
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        },
        {},
      );
      summary.idMap[String(item.id)] = created.id;
      summary.content++;

      const values = Object.fromEntries(
        Object.entries(item.meta).filter(([key]) => !skipMeta.has(key)),
      );
      if (deps.meta && Object.keys(values).length > 0) await deps.meta.setMeta(created.id, values);
      for (const [taxonomy, slugs] of Object.entries(item.terms)) {
        const ids: number[] = [];
        for (const slug of slugs) {
          const term = await deps.taxonomies.getTermBySlug(taxonomy, slug);
          if (term) ids.push(term.id);
        }
        if (ids.length > 0) await deps.taxonomies.setContentTerms(created.id, taxonomy, ids);
      }
    } catch (error) {
      logger.warn(`Import skipped "${item.title}": ${errorText(error)}`);
      summary.skipped.push({ id: item.id, title: item.title, reason: errorText(error) });
    }
  }

  // Settings.
  const patch: Record<string, unknown> = {};
  for (const key of SETTINGS_TO_RESTORE) if (key in file.settings) patch[key] = file.settings[key];
  const front = file.settings.front_page_id;
  if (typeof front === 'number') {
    const mapped = summary.idMap[String(front)];
    if (mapped !== undefined) patch.front_page_id = mapped;
  }
  for (const [key, value] of Object.entries(patch)) {
    try {
      await deps.settings.update({ [key]: value });
      summary.settingsApplied.push(key);
    } catch (error) {
      summary.warnings.push(`Setting "${key}" was not applied: ${errorText(error)}`);
    }
  }
  return summary;
}

function orderParentsFirst<T extends { id: number; parentId: number | null }>(items: T[]): T[] {
  const ids = new Set(items.map((i) => i.id));
  const placed = new Set<number>();
  const out: T[] = [];
  let remaining = [...items];
  while (remaining.length > 0) {
    const next: T[] = [];
    for (const item of remaining) {
      if (item.parentId === null || !ids.has(item.parentId) || placed.has(item.parentId)) {
        out.push(item);
        placed.add(item.id);
      } else next.push(item);
    }
    if (next.length === remaining.length) {
      out.push(...next);
      break;
    }
    remaining = next;
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
