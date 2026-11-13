import { ApiError, request, toError } from './api.js';

/** The subset of the media API's item shape the library screen uses. */
export interface MediaItem {
  id: number;
  url: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string;
  variants: Record<string, string>;
  uploadedBy: number | null;
  createdAt: string;
}

export const MEDIA_PAGE_SIZE = 24;

/** Types the server accepts by default. The server stays the authority; this only pre-filters. */
export const ACCEPTED_TYPES = 'image/jpeg,image/png,image/gif,image/webp,application/pdf';
export const MAX_ALT_LENGTH = 500;

export interface MediaPage {
  items: MediaItem[];
  hasMore: boolean;
}

export const isImage = (item: Pick<MediaItem, 'mime'>): boolean => item.mime.startsWith('image/');

/** The URL of the small preview for a grid tile (the thumbnail variant, else the file itself). */
export function previewUrl(item: MediaItem): string {
  return item.variants.thumbnail ?? item.url;
}

/** The query string for one page. The API has no total, so one extra item reveals a next page. */
export function buildMediaQuery(page: number): string {
  const query = new URLSearchParams();
  query.set('limit', String(MEDIA_PAGE_SIZE + 1));
  query.set('offset', String(Math.max(0, Math.floor(page)) * MEDIA_PAGE_SIZE));
  return query.toString();
}

export async function fetchMediaPage(page: number): Promise<MediaPage> {
  const res = await request(`/api/v1/media?${buildMediaQuery(page)}`);
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { media: MediaItem[] };
  return {
    items: body.media.slice(0, MEDIA_PAGE_SIZE),
    hasMore: body.media.length > MEDIA_PAGE_SIZE,
  };
}

export async function fetchMedia(id: number): Promise<MediaItem> {
  const res = await request(`/api/v1/media/${id}`);
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { media: MediaItem }).media;
}

/** Uploads one file. The body is multipart, so the browser (not `request`) sets the content type. */
export async function uploadFile(file: File, csrfToken: string): Promise<MediaItem> {
  const form = new FormData();
  form.set('file', file);
  const res = await fetch('/api/v1/media', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
    credentials: 'same-origin',
    body: form,
  });
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { media: MediaItem }).media;
}

export interface UploadResult {
  uploaded: MediaItem[];
  failed: { name: string; code: string }[];
}

/** Uploads files one after another; a rejected file never stops the rest. */
export async function uploadFiles(
  files: readonly File[],
  csrfToken: string,
  upload: typeof uploadFile = uploadFile,
): Promise<UploadResult> {
  const result: UploadResult = { uploaded: [], failed: [] };
  for (const file of files) {
    try {
      result.uploaded.push(await upload(file, csrfToken));
    } catch (error) {
      result.failed.push({
        name: file.name,
        code: error instanceof ApiError ? error.code : 'request_failed',
      });
    }
  }
  return result;
}

export async function updateAlt(id: number, alt: string, csrfToken: string): Promise<MediaItem> {
  const res = await request(`/api/v1/media/${id}`, {
    method: 'PATCH',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify({ alt }),
  });
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { media: MediaItem }).media;
}

export async function deleteMedia(id: number, csrfToken: string): Promise<void> {
  const res = await request(`/api/v1/media/${id}`, {
    method: 'DELETE',
    headers: { 'x-csrf-token': csrfToken },
  });
  if (!res.ok) throw await toError(res);
}

/** A reason a person can act on, for a media API error code. */
export function describeMediaError(code: string): string {
  switch (code) {
    case 'too_large':
    case 'payload_too_large':
      return 'the file is too large';
    case 'unsupported_type':
    case 'type_mismatch':
    case 'unsupported_media_type':
      return 'this file type is not allowed';
    case 'invalid_image':
      return 'the image could not be read';
    case 'empty':
      return 'the file is empty';
    case 'invalid_alt':
      return 'the alt text is too long';
    case 'forbidden':
      return 'you do not have permission';
    case 'not_found':
      return 'the file no longer exists';
    default:
      return 'something went wrong';
  }
}

/** A one-line summary of an upload batch for the status message. */
export function describeUpload(result: UploadResult): string {
  const noun = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;
  const reasons = result.failed.map((f) => `${f.name} (${describeMediaError(f.code)})`).join('; ');
  if (result.failed.length === 0) return `${noun(result.uploaded.length)} uploaded.`;
  if (result.uploaded.length === 0) return `Could not upload ${reasons}.`;
  return `${noun(result.uploaded.length)} uploaded. Could not upload ${reasons}.`;
}

/** File size for people: 1.5 MB, 320 KB, 12 B. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
