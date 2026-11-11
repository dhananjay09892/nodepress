import { ApiError, request, toError } from './api.js';

export type ContentStatus = 'draft' | 'scheduled' | 'published' | 'private' | 'trash';

export const STATUS_LABELS: Record<ContentStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  published: 'Published',
  private: 'Private',
  trash: 'Trash',
};

/** The subset of the content API's item shape the list screens use. */
export interface ContentSummary {
  id: number;
  type: string;
  status: ContentStatus;
  title: string;
  slug: string;
  authorId: number | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface ContentPage {
  items: ContentSummary[];
  total: number;
  limit: number;
  offset: number;
}

export const PAGE_SIZE = 20;

export interface ListParams {
  /** Free-text search (the API's `q`). */
  search: string;
  /** One status, or `all` for every status except trash. */
  status: ContentStatus | 'all';
  /** Zero-based page number. */
  page: number;
}

export const FIELDS = 'id,type,status,title,slug,authorId,publishedAt,updatedAt';

/** The query string for one list request. */
export function buildListQuery(params: ListParams): string {
  const query = new URLSearchParams();
  query.set('limit', String(PAGE_SIZE));
  query.set('offset', String(Math.max(0, Math.floor(params.page)) * PAGE_SIZE));
  query.set('sort', '-updatedAt');
  query.set('fields', FIELDS);
  if (params.status !== 'all') query.set('status', params.status);
  else query.set('status', 'draft,scheduled,published,private');
  const search = params.search.trim();
  if (search !== '') query.set('q', search);
  return query.toString();
}

/** The number of pages for a result, never less than one. */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

export async function fetchContentList(type: string, params: ListParams): Promise<ContentPage> {
  const res = await request(
    `/api/v1/content/${encodeURIComponent(type)}?${buildListQuery(params)}`,
  );
  if (!res.ok) throw await toError(res);
  return (await res.json()) as ContentPage;
}

export type BulkAction = 'publish' | 'trash';

export interface BulkResult {
  succeeded: number[];
  failed: { id: number; code: string }[];
}

function csrfHeaders(csrfToken: string): HeadersInit {
  return { 'x-csrf-token': csrfToken };
}

async function applyOne(type: string, id: number, action: BulkAction, csrfToken: string) {
  const path = `/api/v1/content/${encodeURIComponent(type)}/${id}`;
  const res =
    action === 'publish'
      ? await request(path, {
          method: 'PATCH',
          headers: csrfHeaders(csrfToken),
          body: JSON.stringify({ status: 'published' }),
        })
      : await request(path, { method: 'DELETE', headers: csrfHeaders(csrfToken) });
  if (!res.ok) throw await toError(res);
}

/**
 * Applies one action to many items through the single-item routes. Every item is attempted;
 * one failure (a missing capability, an item already gone) never stops the rest.
 */
export async function applyBulk(
  type: string,
  ids: readonly number[],
  action: BulkAction,
  csrfToken: string,
): Promise<BulkResult> {
  const settled = await Promise.allSettled(ids.map((id) => applyOne(type, id, action, csrfToken)));
  const result: BulkResult = { succeeded: [], failed: [] };
  settled.forEach((outcome, index) => {
    const id = ids[index]!;
    if (outcome.status === 'fulfilled') result.succeeded.push(id);
    else {
      const reason: unknown = outcome.reason;
      result.failed.push({
        id,
        code: reason instanceof ApiError ? reason.code : 'request_failed',
      });
    }
  });
  return result;
}

/** A one-line summary of a bulk result for the status message. */
export function describeBulk(action: BulkAction, result: BulkResult): string {
  const verb = action === 'publish' ? 'published' : 'moved to the trash';
  const noun = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;
  if (result.failed.length === 0) return `${noun(result.succeeded.length)} ${verb}.`;
  if (result.succeeded.length === 0) {
    return `Could not change ${noun(result.failed.length)}. You may not have permission.`;
  }
  return `${noun(result.succeeded.length)} ${verb}; ${result.failed.length} could not be changed.`;
}
