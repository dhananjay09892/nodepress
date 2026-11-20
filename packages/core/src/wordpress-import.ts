import type { ContentBlock, ContentService } from './content.js';
import { htmlToBlocks, mapBlockUrls, type ImportedBlock } from './html-blocks.js';
import { silentLogger, type Logger } from './logger.js';
import type { PermalinkService } from './permalinks.js';
import { slugify } from './content.js';
import type { TaxonomyService } from './taxonomies.js';
import { parseWxr, type WxrExport, type WxrItem } from './wxr.js';

/** One WordPress author from the export, to be matched with a NodePress user. */
export interface ImportAuthor {
  login: string;
  email: string;
  displayName: string;
}

export interface WordPressImportOptions {
  content: Pick<ContentService, 'create' | 'update'>;
  taxonomies: Pick<TaxonomyService, 'getTermBySlug' | 'createTerm' | 'setContentTerms'>;
  /** Gives the new public path of imported content (redirects and link rewriting use it). */
  permalinks: Pick<PermalinkService, 'pathFor'>;
  /** Where comments and WordPress ids are kept (`content_meta`). Skipped when absent. */
  meta?: { setMeta(contentId: number, values: Record<string, unknown>): Promise<void> };
  /**
   * Which NodePress user owns an item written by this WordPress author. Return null for "nobody".
   * Defaults to `defaultAuthorId` for everyone.
   */
  resolveAuthor?: (author: ImportAuthor) => number | null | Promise<number | null>;
  defaultAuthorId?: number | null;
  logger?: Logger;
  now?: () => Date;
}

export interface ImportRedirect {
  /** Path on the old site, without query or trailing slash (`/` stays `/`). */
  from: string;
  /** Path of the same content now. */
  to: string;
}

export interface ImportedAttachment {
  id?: number;
  url: string;
  title: string;
  alt: string;
  /** NodePress id of the post or page it was attached to, when that was imported. */
  contentId?: number;
}

export interface ImportSkipped {
  id?: number;
  title: string;
  type: string;
  reason: string;
}

export interface ImportReport {
  site: { title: string; url: string };
  /** Counts of what was created. */
  created: { posts: number; pages: number; categories: number; tags: number };
  /** WordPress id → NodePress id, for posts and pages. */
  idMap: Record<string, number>;
  /** Old URL path → new path, only where they differ and the item is public. */
  redirects: ImportRedirect[];
  /** Files the export lists. They are not downloaded by this import. */
  attachments: ImportedAttachment[];
  /** Number of internal links changed to the new URLs. */
  linksRewritten: number;
  skipped: ImportSkipped[];
  warnings: string[];
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUS: Record<string, 'published' | 'draft' | 'scheduled' | 'private' | 'trash'> = {
  publish: 'published',
  draft: 'draft',
  pending: 'draft',
  auto_draft: 'draft',
  future: 'scheduled',
  private: 'private',
  trash: 'trash',
};
const MAX_TITLE = 500;
const MAX_EXCERPT = 5000;

/** `2024-05-01 10:00:00` as UTC. Returns undefined for blanks and WordPress's zero date. */
export function parseWpDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match || match[1] === '0000') return undefined;
  const [, y, mo, d, h, mi, s] = match.map(Number) as [number, number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC rolls 13/45 over silently; accept only dates that read back the same.
  const same =
    date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d &&
    date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === s;
  return same ? date : undefined;
}

/** Normalize a path for matching: no trailing slash (except `/`), no query or hash. */
export function normalizePath(path: string): string {
  const bare = path.split('#', 1)[0]?.split('?', 1)[0] ?? '';
  const trimmed = bare.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function pathOf(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/** Where a WordPress link points inside the site, as `{path, suffix}`; undefined if it is external. */
function internalTarget(
  url: string,
  hosts: ReadonlySet<string>,
): { path: string; query: string; suffix: string } | undefined {
  const value = url.trim();
  if (value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const host = hostOf(value.startsWith('//') ? `https:${value}` : value);
    if (!host || !hosts.has(host)) return undefined;
    const parsed = new URL(value.startsWith('//') ? `https:${value}` : value);
    return { path: parsed.pathname, query: parsed.search, suffix: parsed.hash };
  }
  if (!value.startsWith('/')) return undefined;
  const parsed = new URL(value, 'https://placeholder.invalid');
  return { path: parsed.pathname, query: parsed.search, suffix: parsed.hash };
}

function numberedQuery(query: string): number | undefined {
  const params = new URLSearchParams(query);
  const raw = params.get('p') ?? params.get('page_id');
  return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

async function termIdFor(
  options: WordPressImportOptions,
  cache: Map<string, number>,
  taxonomy: 'category' | 'tag',
  slug: string,
  name: string,
  parentId: number | null,
  description: string | null,
  report: ImportReport,
): Promise<number> {
  const key = `${taxonomy}:${slug || slugify(name)}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const wanted = slug && SLUG.test(slug) ? slug : slugify(name);
  const existing = await options.taxonomies.getTermBySlug(taxonomy, wanted);
  if (existing) {
    cache.set(key, existing.id);
    return existing.id;
  }
  const created = await options.taxonomies.createTerm({
    taxonomy,
    name: name || wanted,
    slug: wanted,
    ...(description ? { description } : {}),
    ...(taxonomy === 'category' ? { parentId } : {}),
  });
  cache.set(key, created.id);
  if (taxonomy === 'category') report.created.categories++;
  else report.created.tags++;
  return created.id;
}

/**
 * Import a WordPress export (WXR text or an already parsed one).
 *
 * Creates categories, tags, posts and pages (HTML converted to blocks), keeps WordPress ids and
 * comments as meta, rewrites links between imported items to their new URLs, and reports the
 * redirects needed to keep old URLs working. Files are listed in `attachments`, not downloaded.
 * One bad item is reported in `skipped` and never stops the rest.
 */
export async function importWordPress(
  source: string | WxrExport,
  options: WordPressImportOptions,
): Promise<ImportReport> {
  const logger = options.logger ?? silentLogger;
  const wxr = typeof source === 'string' ? parseWxr(source) : source;
  const report: ImportReport = {
    site: { title: wxr.title, url: wxr.siteUrl },
    created: { posts: 0, pages: 0, categories: 0, tags: 0 },
    idMap: {},
    redirects: [],
    attachments: [],
    linksRewritten: 0,
    skipped: [],
    warnings: [],
  };
  const termCache = new Map<string, number>();

  // Categories: parents first.
  const categoriesBySlug = new Map(wxr.categories.map((c) => [c.slug, c]));
  const doneCategories = new Set<string>();
  const addCategory = async (slug: string, depth = 0): Promise<number | null> => {
    const category = categoriesBySlug.get(slug);
    if (!category || depth > 20) return null;
    let parentId: number | null = null;
    if (category.parent && category.parent !== slug) parentId = await addCategory(category.parent, depth + 1);
    doneCategories.add(slug);
    return termIdFor(options, termCache, 'category', category.slug, category.name, parentId, category.description ?? null, report);
  };
  for (const category of wxr.categories) {
    try {
      await addCategory(category.slug);
    } catch (error) {
      report.warnings.push(`Category "${category.name}" was not imported: ${messageOf(error)}`);
    }
  }
  for (const tag of wxr.tags) {
    try {
      await termIdFor(options, termCache, 'tag', tag.slug, tag.name, null, tag.description ?? null, report);
    } catch (error) {
      report.warnings.push(`Tag "${tag.name}" was not imported: ${messageOf(error)}`);
    }
  }

  const authors = new Map(wxr.authors.map((a) => [a.login, a]));
  const authorCache = new Map<string, number | null>();
  const authorIdFor = async (login: string): Promise<number | null> => {
    if (authorCache.has(login)) return authorCache.get(login) ?? null;
    const author = authors.get(login) ?? { login, email: '', displayName: login };
    let id = options.defaultAuthorId ?? null;
    if (options.resolveAuthor) id = await options.resolveAuthor(author);
    authorCache.set(login, id);
    return id;
  };

  const items = wxr.items;
  const byWpId = new Map<number, WxrItem>();
  for (const item of items) if (item.id !== undefined) byWpId.set(item.id, item);

  const importable = items.filter((item) => item.type === 'post' || item.type === 'page');
  for (const item of items) {
    if (item.type === 'attachment') {
      if (item.attachmentUrl) {
        report.attachments.push({
          ...(item.id !== undefined ? { id: item.id } : {}),
          url: item.attachmentUrl,
          title: item.title,
          alt: item.meta['_wp_attachment_image_alt'] ?? '',
        });
      }
    } else if (item.type !== 'post' && item.type !== 'page' && item.type !== 'nav_menu_item') {
      report.skipped.push({
        ...(item.id !== undefined ? { id: item.id } : {}),
        title: item.title,
        type: item.type,
        reason: `"${item.type}" content is not imported`,
      });
    }
  }

  // Pages with parents come after their parents.
  const ordered: WxrItem[] = [];
  const placed = new Set<WxrItem>();
  const place = (item: WxrItem, depth = 0): void => {
    if (placed.has(item)) return;
    const parent = item.parent !== undefined ? byWpId.get(item.parent) : undefined;
    if (parent && parent !== item && importable.includes(parent) && depth < 50) place(parent, depth + 1);
    placed.add(item);
    ordered.push(item);
  };
  importable.forEach((item) => place(item));

  const now = (options.now ?? (() => new Date()))();
  const created: Array<{ item: WxrItem; id: number; path: string; blocks: ImportedBlock[]; status: string }> = [];
  for (const item of ordered) {
    const mapped = STATUS[item.status];
    if (!mapped) {
      report.skipped.push({
        ...(item.id !== undefined ? { id: item.id } : {}),
        title: item.title,
        type: item.type,
        reason: `status "${item.status}" is not imported`,
      });
      continue;
    }
    try {
      const date = parseWpDate(item.dateGmt) ?? parseWpDate(item.date);
      let status = mapped;
      let publishedAt: Date | null = null;
      if (status === 'published' || status === 'private') publishedAt = date ?? now;
      if (status === 'scheduled') {
        if (date && date.getTime() > now.getTime()) publishedAt = date;
        else {
          status = 'published';
          publishedAt = date ?? now;
        }
      }
      const slug = item.slug && SLUG.test(item.slug) ? item.slug : undefined;
      if (item.slug && !slug) {
        report.warnings.push(`"${item.title}": slug "${item.slug}" was replaced by one made from the title`);
      }
      const blocks = htmlToBlocks(item.content);
      const authorId = await authorIdFor(item.creator);
      const parentWp = item.parent !== undefined ? report.idMap[String(item.parent)] : undefined;
      const record = await options.content.create({
        type: item.type,
        title: item.title.slice(0, MAX_TITLE) || '(no title)',
        ...(slug ? { slug } : {}),
        status,
        body: blocks as unknown as ContentBlock[],
        excerpt: item.excerpt.trim() === '' ? null : item.excerpt.trim().slice(0, MAX_EXCERPT),
        authorId,
        parentId: item.type === 'page' && parentWp !== undefined ? parentWp : null,
        publishedAt,
      });
      if (item.id !== undefined) report.idMap[String(item.id)] = record.id;
      if (item.type === 'post') report.created.posts++;
      else report.created.pages++;

      const termIds: Record<'category' | 'tag', number[]> = { category: [], tag: [] };
      for (const term of item.terms) {
        // Other taxonomies have no home yet.
        if (term.taxonomy !== 'category' && term.taxonomy !== 'tag') continue;
        try {
          const id = await termIdFor(options, termCache, term.taxonomy, term.slug, term.name, null, null, report);
          if (!termIds[term.taxonomy].includes(id)) termIds[term.taxonomy].push(id);
        } catch (error) {
          report.warnings.push(`"${item.title}": term "${term.name}" was not added: ${messageOf(error)}`);
        }
      }
      for (const taxonomy of ['category', 'tag'] as const) {
        if (termIds[taxonomy].length === 0) continue;
        try {
          await options.taxonomies.setContentTerms(record.id, taxonomy, termIds[taxonomy]);
        } catch (error) {
          report.warnings.push(`"${item.title}": ${taxonomy} terms were not saved: ${messageOf(error)}`);
        }
      }
      if (options.meta) {
        const values: Record<string, unknown> = {
          wp_link: item.link,
          ...(item.id !== undefined ? { wp_id: item.id } : {}),
          ...(item.comments.length > 0 ? { wp_comments: item.comments } : {}),
        };
        await options.meta.setMeta(record.id, values);
      }
      created.push({ item, id: record.id, path: await options.permalinks.pathFor(record), blocks, status });
    } catch (error) {
      logger.warn(`Could not import "${item.title}": ${messageOf(error)}`);
      report.skipped.push({
        ...(item.id !== undefined ? { id: item.id } : {}),
        title: item.title,
        type: item.type,
        reason: messageOf(error),
      });
    }
  }

  // Attachments know their post now.
  for (const attachment of report.attachments) {
    const wp = items.find((i) => i.id === attachment.id);
    const parentId = wp?.parent !== undefined ? report.idMap[String(wp.parent)] : undefined;
    if (parentId !== undefined) attachment.contentId = parentId;
  }

  // Links between imported items, and the redirect map.
  const hosts = new Set<string>();
  for (const url of [wxr.siteUrl, wxr.baseUrl]) {
    const host = hostOf(url);
    if (host) hosts.add(host);
  }
  const pathMap = new Map<string, string>();
  const idToPath = new Map<number, string>();
  for (const entry of created) {
    if (entry.item.id !== undefined) idToPath.set(entry.item.id, entry.path);
    const oldPath = pathOf(entry.item.link);
    if (oldPath !== undefined && entry.item.link !== '') pathMap.set(normalizePath(oldPath), entry.path);
  }
  for (const entry of created) {
    const oldPath = pathOf(entry.item.link);
    const isPublic = entry.status === 'published' || entry.status === 'scheduled';
    if (oldPath !== undefined && entry.item.link !== '' && isPublic) {
      const from = normalizePath(oldPath);
      if (from !== normalizePath(entry.path) && !report.redirects.some((r) => r.from === from)) {
        report.redirects.push({ from, to: entry.path });
      }
    }
  }
  const rewrite = (url: string): string => {
    const target = internalTarget(url, hosts);
    if (!target) return url;
    const wpId = numberedQuery(target.query);
    const next =
      wpId !== undefined && normalizePath(target.path) === '/'
        ? idToPath.get(wpId)
        : pathMap.get(normalizePath(target.path));
    if (next === undefined) return url;
    report.linksRewritten++;
    return `${next}${wpId !== undefined ? '' : target.query}${target.suffix}`;
  };
  for (const entry of created) {
    const before = report.linksRewritten;
    const blocks = mapBlockUrls(entry.blocks, (url, kind) => (kind === 'link' ? rewrite(url) : url));
    if (report.linksRewritten === before) continue;
    try {
      await options.content.update(entry.id, { body: blocks as unknown as ContentBlock[] });
    } catch (error) {
      report.warnings.push(`"${entry.item.title}": links were not rewritten: ${messageOf(error)}`);
    }
  }

  return report;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
