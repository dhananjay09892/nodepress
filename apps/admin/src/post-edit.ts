import type { Block } from '@nodepress/editor';
import { ApiError, describeError, request, toError } from './api.js';
import type { ContentStatus } from './content.js';
import { CATEGORY_TAXONOMY, sameIds, TAG_TAXONOMY, type TermItem } from './terms.js';

/** The custom field (registered by core) that holds a post's featured image: a media id. */
export const FEATURED_IMAGE_FIELD = 'featured_image';

/** A content item as the edit screen uses it (the content API's full item shape). */
export interface ContentItem {
  id: number;
  type: string;
  status: ContentStatus;
  title: string;
  slug: string;
  /** The block envelope's blocks (`content.body`). */
  body: Block[];
  excerpt: string | null;
  authorId: number | null;
  publishedAt: string | null;
  /** Custom field values (present when the server stores them). */
  meta?: Record<string, unknown>;
  /** Assigned terms by taxonomy name (present when the server has taxonomies). */
  terms?: Record<string, TermItem[]>;
  createdAt: string;
  updatedAt: string;
}

/** One saved version of an item. */
export interface RevisionItem {
  id: number;
  contentId: number;
  authorId: number | null;
  createdAt: string;
  snapshot: {
    title: string;
    slug: string;
    status: string;
    body: Block[];
    excerpt: string | null;
    publishedAt: string | null;
  };
}

/** What the form edits. `publishedAt` is a `datetime-local` value (local time), or empty. */
export interface EditState {
  title: string;
  slug: string;
  excerpt: string;
  status: ContentStatus;
  publishedAt: string;
  body: Block[];
  categoryIds: number[];
  tagIds: number[];
  /** The id of the featured image in the media library, or `null`. */
  featuredImage: number | null;
}

/** The fields the API accepts on a write, as the edit screen sends them. */
export interface ContentPatch {
  title?: string;
  slug?: string;
  excerpt?: string | null;
  status?: ContentStatus;
  publishedAt?: string | null;
  body?: Block[];
  /** Taxonomy name to the full list of term ids (the API replaces the assignment). */
  terms?: Record<string, number[]>;
  /** Custom field values; `null` clears one. */
  meta?: Record<string, number | null>;
}

export const EMPTY_STATE: EditState = {
  title: '',
  slug: '',
  excerpt: '',
  status: 'draft',
  publishedAt: '',
  body: [],
  categoryIds: [],
  tagIds: [],
  featuredImage: null,
};

const pad = (n: number) => String(n).padStart(2, '0');

/** An ISO timestamp as a `datetime-local` input value in the viewer's time zone. */
export function isoToLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** A `datetime-local` value as an ISO timestamp; `null` when empty, `undefined` when invalid. */
export function localInputToIso(value: string): string | null | undefined {
  if (value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The form state for a saved item or one of its revisions. */
export function toEditState(source: {
  title: string;
  slug: string;
  excerpt: string | null;
  status: string;
  publishedAt: string | null;
  body: Block[];
  meta?: Record<string, unknown> | undefined;
  terms?: Record<string, { id: number }[]> | undefined;
}): EditState {
  const image = source.meta?.[FEATURED_IMAGE_FIELD];
  return {
    title: source.title,
    slug: source.slug,
    excerpt: source.excerpt ?? '',
    status: source.status as ContentStatus,
    publishedAt: isoToLocalInput(source.publishedAt),
    body: source.body,
    categoryIds: (source.terms?.[CATEGORY_TAXONOMY] ?? []).map((t) => t.id),
    tagIds: (source.terms?.[TAG_TAXONOMY] ?? []).map((t) => t.id),
    featuredImage: typeof image === 'number' ? image : null,
  };
}

/**
 * The fields of `current` that differ from `saved`, ready to send. The status of an item in the
 * trash is never sent (the API restores items by setting another status, not by echoing `trash`),
 * and a publish date that is not a valid date is left out.
 */
export function buildPatch(
  current: EditState,
  saved: EditState,
  options: { includeStatus?: boolean } = {},
): ContentPatch {
  const includeStatus = options.includeStatus ?? true;
  const patch: ContentPatch = {};
  if (current.title !== saved.title) patch.title = current.title;
  if (current.slug !== saved.slug) patch.slug = current.slug;
  if (current.excerpt !== saved.excerpt) {
    patch.excerpt = current.excerpt.trim() === '' ? null : current.excerpt;
  }
  if (includeStatus && current.status !== saved.status && current.status !== 'trash') {
    patch.status = current.status;
  }
  if (current.publishedAt !== saved.publishedAt) {
    const iso = localInputToIso(current.publishedAt);
    if (iso !== undefined) patch.publishedAt = iso;
  }
  if (JSON.stringify(current.body) !== JSON.stringify(saved.body)) patch.body = current.body;
  // Terms are sent per taxonomy and only for the ones that changed; the server needs
  // `manage_categories` for any `terms` key, so untouched ones must not be sent.
  const terms: Record<string, number[]> = {};
  if (!sameIds(current.categoryIds, saved.categoryIds))
    terms[CATEGORY_TAXONOMY] = current.categoryIds;
  if (!sameIds(current.tagIds, saved.tagIds)) terms[TAG_TAXONOMY] = current.tagIds;
  if (Object.keys(terms).length > 0) patch.terms = terms;
  if (current.featuredImage !== saved.featuredImage) {
    patch.meta = { [FEATURED_IMAGE_FIELD]: current.featuredImage };
  }
  return patch;
}

/**
 * The form after a save. What the person typed while the request ran is kept, but a value the
 * server chose is taken when the form still held the one that was sent (or none): a slug made
 * from the title, the publish date set when an item goes live, a status the server adjusted.
 * Without this the form would look changed right after saving and would send the old value back.
 */
export function adoptServerValues(
  current: EditState,
  base: EditState,
  sent: ContentPatch,
  next: EditState,
): EditState {
  const sentDate =
    sent.publishedAt === undefined ? base.publishedAt : isoToLocalInput(sent.publishedAt);
  return {
    ...current,
    slug: current.slug === (sent.slug ?? base.slug) ? next.slug : current.slug,
    publishedAt: current.publishedAt === sentDate ? next.publishedAt : current.publishedAt,
    status: current.status === (sent.status ?? base.status) ? next.status : current.status,
  };
}

/** True when saving `current` would change anything on the server. */
export function isDirty(current: EditState, saved: EditState): boolean {
  return Object.keys(buildPatch(current, saved)).length > 0;
}

/**
 * Whether the screen may save by itself. Only drafts autosave: saving a published item would
 * put half-written edits on the live site, so those wait for the Update button.
 */
export function canAutosave(saved: EditState): boolean {
  return saved.status === 'draft';
}

/** Statuses a person can choose in the editor (trash is reached through the list screens). */
export function statusChoices(saved: ContentStatus): ContentStatus[] {
  const choices: ContentStatus[] = ['draft', 'scheduled', 'published', 'private'];
  return saved === 'trash' ? ['trash', ...choices] : choices;
}

/** The label of the main save button for the item's current and chosen status. */
export function saveLabel(isNew: boolean, status: ContentStatus): string {
  if (status === 'published') return isNew ? 'Publish' : 'Update';
  if (status === 'scheduled') return 'Schedule';
  return isNew ? 'Save draft' : 'Save changes';
}

/** A short line naming what a revision holds, for the history list. */
export function describeRevision(revision: RevisionItem, index: number, total: number): string {
  const title = revision.snapshot.title.trim() === '' ? '(no title)' : revision.snapshot.title;
  const position =
    index === 0 ? 'Latest' : index === total - 1 ? 'First' : `Version ${total - index}`;
  return `${position}: ${title} (${revision.snapshot.status})`;
}

function csrfHeaders(csrfToken: string): HeadersInit {
  return { 'x-csrf-token': csrfToken };
}

const itemPath = (type: string, id: number) => `/api/v1/content/${encodeURIComponent(type)}/${id}`;

export async function fetchContent(type: string, id: number): Promise<ContentItem> {
  const res = await request(itemPath(type, id));
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { item: ContentItem }).item;
}

export async function createContent(
  type: string,
  input: ContentPatch,
  csrfToken: string,
): Promise<ContentItem> {
  const res = await request(`/api/v1/content/${encodeURIComponent(type)}`, {
    method: 'POST',
    headers: csrfHeaders(csrfToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { item: ContentItem }).item;
}

export async function updateContent(
  type: string,
  id: number,
  patch: ContentPatch,
  csrfToken: string,
): Promise<ContentItem> {
  const res = await request(itemPath(type, id), {
    method: 'PATCH',
    headers: csrfHeaders(csrfToken),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { item: ContentItem }).item;
}

/** Saved versions of an item, newest first. */
export async function fetchRevisions(type: string, id: number): Promise<RevisionItem[]> {
  const res = await request(`${itemPath(type, id)}/revisions`);
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { revisions: RevisionItem[] }).revisions;
}

/** A sentence a person can act on, for an error while loading or saving an item. */
export function describeSaveError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_request') {
      return 'The server rejected something you entered, such as the slug or the publish date. Check the fields and try again.';
    }
    if (error.code === 'not_found') return 'This item no longer exists, or you cannot see it.';
    if (error.code === 'payload_too_large') return 'This content is too large to save.';
    if (error.status === 401)
      return 'You were signed out. Sign in again; your edits on this page are still here.';
  }
  return describeError(error);
}
