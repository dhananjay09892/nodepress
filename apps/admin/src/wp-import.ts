import { ApiError, request, toError } from './api.js';

/** Largest export the server takes (`MAX_WXR_BYTES` in `@nodepress/core`). */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface WpImportReport {
  site: { title: string; url: string };
  created: { posts: number; pages: number; categories: number; tags: number };
  redirects: Array<{ from: string; to: string }>;
  attachments: Array<{ url: string; title: string }>;
  linksRewritten: number;
  skipped: Array<{ title: string; type: string; reason: string }>;
  warnings: string[];
  authorsMatched: number;
  redirectsSaved?: { created: number; skipped: Array<{ from: string; message: string }> };
}

export interface WpImportOptions {
  /** User id that gets items whose author has no match; the signed-in user when omitted. */
  defaultAuthor?: number | undefined;
  matchAuthors: boolean;
}

/** An API error that may carry the server's explanation (for example an unreadable export). */
export class ImportApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly detail?: string | undefined,
  ) {
    super(status, code);
  }
}

/**
 * The size limit when this user may import, or `null` when they may not (403) or the site has
 * the importer turned off (404); either keeps the sidebar entry hidden.
 */
export async function fetchImportLimit(): Promise<{ maxBytes: number } | null> {
  const res = await request('/api/v1/import/wordpress');
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { maxBytes?: unknown };
  return { maxBytes: typeof body.maxBytes === 'number' ? body.maxBytes : DEFAULT_MAX_BYTES };
}

/** The query string for the import call; empty when the defaults apply. */
export function importQuery(options: WpImportOptions): string {
  const params = new URLSearchParams();
  if (options.defaultAuthor !== undefined)
    params.set('default_author', String(options.defaultAuthor));
  if (!options.matchAuthors) params.set('match_authors', 'false');
  const text = params.toString();
  return text ? `?${text}` : '';
}

export async function importWordPress(
  xml: string,
  options: WpImportOptions,
  csrfToken: string,
): Promise<WpImportReport> {
  const res = await request(`/api/v1/import/wordpress${importQuery(options)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/xml', 'x-csrf-token': csrfToken },
    body: xml,
  });
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const data = (await res.clone().json()) as { message?: unknown };
      if (typeof data.message === 'string') detail = data.message;
    } catch {
      // Not JSON; the code is enough.
    }
    const error = await toError(res);
    throw new ImportApiError(error.status, error.code, detail);
  }
  return (await res.json()) as WpImportReport;
}

/** Whether a chosen file can be sent: an XML file within the server's limit. */
export function checkExportFile(
  file: { name: string; size: number },
  maxBytes: number,
): string | null {
  if (!/\.xml$/i.test(file.name)) return 'Choose the .xml file that WordPress exported.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > maxBytes) {
    return `That file is too large (${Math.floor(maxBytes / (1024 * 1024))} MB at most).`;
  }
  return null;
}

/** A sentence a person can act on for an import failure. */
export function describeImportError(error: unknown): string {
  if (error instanceof ImportApiError) {
    switch (error.status) {
      case 400:
        return error.detail ?? 'The server could not use that file.';
      case 403:
        return 'You do not have permission to import.';
      case 409:
        return 'Another import is still running. Wait for it to finish and try again.';
      case 413:
        return 'That file is too large.';
      case 415:
        return 'Choose the .xml file that WordPress exported.';
    }
  }
  return 'Something went wrong. Try again.';
}

/** The headline numbers as sentences, for the report. */
export function summarizeReport(report: WpImportReport): string[] {
  const { posts, pages, categories, tags } = report.created;
  const lines = [
    `Imported ${posts} ${posts === 1 ? 'post' : 'posts'}, ${pages} ${pages === 1 ? 'page' : 'pages'}, ${categories} ${categories === 1 ? 'category' : 'categories'} and ${tags} ${tags === 1 ? 'tag' : 'tags'} from ${report.site.title || 'the export'}.`,
    `${report.authorsMatched} ${report.authorsMatched === 1 ? 'author was' : 'authors were'} matched to existing users by email.`,
    `${report.linksRewritten} ${report.linksRewritten === 1 ? 'link' : 'links'} between imported items ${report.linksRewritten === 1 ? 'was' : 'were'} updated.`,
  ];
  if (report.redirectsSaved) {
    const saved = report.redirectsSaved;
    lines.push(
      `${saved.created} ${saved.created === 1 ? 'redirect was' : 'redirects were'} saved so old links keep working${saved.skipped.length ? ` (${saved.skipped.length} could not be saved)` : ''}.`,
    );
  } else if (report.redirects.length > 0) {
    lines.push(
      `${report.redirects.length} old addresses differ from the new ones, but redirects are turned off on this site.`,
    );
  }
  if (report.attachments.length > 0) {
    lines.push(
      `${report.attachments.length} ${report.attachments.length === 1 ? 'file is' : 'files are'} listed in the export but not downloaded yet.`,
    );
  }
  return lines;
}
