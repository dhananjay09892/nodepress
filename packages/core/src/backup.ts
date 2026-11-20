import { z } from 'zod';
import type { ContentService, Content, ContentStatusName } from './content.js';
import { CONTENT_STATUSES } from './content.js';
import { silentLogger, type Logger } from './logger.js';
import type { Menu, MenuItem, MenuService } from './menus.js';
import type { RedirectsService } from './redirects.js';
import type { SettingsService } from './settings.js';
import type { TaxonomyService } from './taxonomies.js';
import type { WidgetInstance, WidgetService } from './widgets.js';

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
  /** Navigation menus (absent in files made before menus were backed up). */
  menus?: ExportedMenu[];
  /** Menu location of the theme → id of the menu assigned to it. */
  menuLocations?: Record<string, number>;
  /** Widget area of the theme → the widgets placed in it. */
  widgets?: Record<string, ExportedWidget[]>;
  /** Redirect rules. */
  redirects?: ExportedRedirect[];
}

export interface ExportedMenu {
  id: number;
  name: string;
  items: MenuItem[];
}

export interface ExportedWidget {
  id: string;
  type: string;
  settings: Record<string, unknown>;
}

export interface ExportedRedirect {
  from: string;
  to: string;
  status: number;
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
  /** Menus: exported with their location assignments, and added on import. */
  menus?: Pick<MenuService, 'list' | 'create' | 'getLocations' | 'setLocations'>;
  /** Widgets placed in the areas of the active theme. */
  widgets?: Pick<WidgetService, 'getAreas' | 'setAreas'>;
  /** The menu locations of the active theme (empty or missing without a theme). */
  menuLocations?: () => readonly string[];
  /** The widget areas of the active theme (empty or missing without a theme). */
  widgetAreas?: () => readonly string[];
  /** Redirect rules: exported, and added on import. */
  redirects?: Pick<RedirectsService, 'list' | 'addMany'>;
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

  const result: SiteExport = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now().toISOString(),
    settings: { ...(await deps.settings.getAll()) },
    terms,
    content,
    authors,
  };
  if (deps.menus) {
    const menus: Menu[] = await deps.menus.list();
    result.menus = menus.map((m) => ({ id: m.id, name: m.name, items: m.items }));
    result.menuLocations = await deps.menus.getLocations();
  }
  if (deps.widgets) {
    const areas = await deps.widgets.getAreas(deps.widgetAreas?.() ?? []);
    result.widgets = Object.fromEntries(
      Object.entries(areas)
        .filter(([, list]) => list.length > 0)
        .map(([area, list]) => [area, list.map(exportedWidget)]),
    );
  }
  if (deps.redirects) {
    result.redirects = (await deps.redirects.list()).map((r) => ({
      from: r.from,
      to: r.to,
      status: r.status,
    }));
  }
  return result;
}

function exportedWidget(widget: WidgetInstance): ExportedWidget {
  return { id: widget.id, type: widget.type, settings: widget.settings };
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
  // Absent in files from before these were backed up. Each service checks the details on import.
  menus: z
    .array(z.object({ id: z.number().int(), name: text(200), items: z.array(z.unknown()).max(1000) }))
    .max(200)
    .optional(),
  menuLocations: z.record(text(100), z.number().int()).optional(),
  widgets: z
    .record(
      text(100),
      z
        .array(
          z.object({
            id: text(100).optional(),
            type: text(100),
            settings: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .max(100),
    )
    .optional(),
  redirects: z
    .array(z.object({ from: text(1000), to: text(4000), status: z.number().int() }))
    .max(10_000)
    .optional(),
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
  /** Menus, widgets and redirects added (absent when the file has none or the site cannot take them). */
  menus: number;
  widgets: number;
  redirects: number;
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
    menus: 0,
    widgets: 0,
    redirects: 0,
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

  const menuIds = await importMenus(file, deps, summary);
  await importWidgets(file, deps, summary, menuIds);
  await importRedirects(file, deps, summary);
  return summary;
}

/**
 * Menus are added next to the existing ones (the service checks every item). A location of the
 * theme gets its menu only when it has none yet, so the look of the site is not changed.
 */
async function importMenus(
  file: { menus?: Array<{ id: number; name: string; items: unknown[] }>; menuLocations?: Record<string, number> },
  deps: BackupDeps,
  summary: ImportSummary,
): Promise<Map<number, number>> {
  const menuIds = new Map<number, number>();
  if (!file.menus || file.menus.length === 0) return menuIds;
  if (!deps.menus) {
    summary.warnings.push('Menus in the file were not restored: this site cannot manage menus.');
    return menuIds;
  }
  for (const menu of file.menus) {
    try {
      const created = await deps.menus.create({ name: menu.name, items: menu.items });
      menuIds.set(menu.id, created.id);
      summary.menus++;
    } catch (error) {
      summary.warnings.push(`Menu "${menu.name}" skipped: ${errorText(error)}`);
    }
  }
  const known = deps.menuLocations?.() ?? [];
  const current = await deps.menus.getLocations();
  for (const [location, oldId] of Object.entries(file.menuLocations ?? {})) {
    const newId = menuIds.get(oldId);
    if (newId === undefined) continue;
    if (!known.includes(location)) {
      summary.warnings.push(`Menu location "${location}" does not exist in this theme; not assigned.`);
    } else if (current[location] !== undefined) {
      summary.warnings.push(`Menu location "${location}" already has a menu; left as it is.`);
    } else {
      try {
        await deps.menus.setLocations({ [location]: newId }, known);
      } catch (error) {
        summary.warnings.push(`Menu location "${location}" not assigned: ${errorText(error)}`);
      }
    }
  }
  return menuIds;
}


/**
 * Widgets go into the areas of the active theme that have none yet; a menu widget is pointed at
 * the new id of its menu (and left out when the menu was not restored).
 */
async function importWidgets(
  file: {
    widgets?: Record<string, Array<{ id?: string | undefined; type: string; settings?: Record<string, unknown> | undefined }>>;
  },
  deps: BackupDeps,
  summary: ImportSummary,
  menuIds: Map<number, number>,
): Promise<void> {
  const areas = Object.entries(file.widgets ?? {});
  if (areas.length === 0) return;
  if (!deps.widgets) {
    summary.warnings.push('Widgets in the file were not restored: this site cannot manage widgets.');
    return;
  }
  const known = deps.widgetAreas?.() ?? [];
  const current = await deps.widgets.getAreas(known);
  for (const [area, list] of areas) {
    if (!known.includes(area)) {
      summary.warnings.push(`Widget area "${area}" does not exist in this theme; its widgets were skipped.`);
      continue;
    }
    if ((current[area] ?? []).length > 0) {
      summary.warnings.push(`Widget area "${area}" already has widgets; left as it is.`);
      continue;
    }
    const widgets: Array<{ type: string; settings: Record<string, unknown> }> = [];
    for (const widget of list) {
      const settings = { ...(widget.settings ?? {}) };
      if (widget.type === 'menu') {
        const mapped = typeof settings['menuId'] === 'number' ? menuIds.get(settings['menuId']) : undefined;
        if (mapped === undefined) {
          summary.warnings.push(`A menu widget in "${area}" was skipped: its menu was not restored.`);
          continue;
        }
        settings['menuId'] = mapped;
      }
      widgets.push({ type: widget.type, settings });
    }
    try {
      await deps.widgets.setAreas({ [area]: widgets }, known);
      summary.widgets += widgets.length;
    } catch (error) {
      summary.warnings.push(`Widgets of "${area}" skipped: ${errorText(error)}`);
    }
  }
}

/** Redirect rules are added (invalid ones, and ones for a path that already has a rule, are reported). */
async function importRedirects(
  file: { redirects?: Array<{ from: string; to: string; status: number }> },
  deps: BackupDeps,
  summary: ImportSummary,
): Promise<void> {
  if (!file.redirects || file.redirects.length === 0) return;
  if (!deps.redirects) {
    summary.warnings.push('Redirects in the file were not restored: this site cannot manage redirects.');
    return;
  }
  const result = await deps.redirects.addMany(file.redirects);
  summary.redirects = result.created;
  for (const skipped of result.skipped) {
    summary.warnings.push(`Redirect from "${skipped.from}" skipped: ${skipped.message}`);
  }
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
