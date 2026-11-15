import { request, toError, ApiError } from './api.js';

/** The settings API's values; the keys are the option names. */
export interface SettingsValues {
  site_title: string;
  tagline: string;
  timezone: string;
  front_page_id: number | null;
  posts_per_page: number;
  discourage_search_engines: boolean;
  permalink_structure: string;
  api_public_read: boolean;
}

export type SettingsSection = 'general' | 'reading' | 'permalinks';

/** Which settings each screen edits, so saving one screen never sends another's values. */
export const SECTION_KEYS: Record<SettingsSection, readonly (keyof SettingsValues)[]> = {
  general: ['site_title', 'tagline', 'timezone'],
  reading: ['front_page_id', 'posts_per_page', 'discourage_search_engines', 'api_public_read'],
  permalinks: ['permalink_structure'],
};

export const SECTION_LABELS: Record<SettingsSection, string> = {
  general: 'General',
  reading: 'Reading',
  permalinks: 'Permalinks',
};

export const MAX_POSTS_PER_PAGE = 100;

/** A ready-made choice on the Permalinks screen; `custom` lets the person type a pattern. */
export const PERMALINK_PRESETS = [
  { pattern: '/blog/:slug', label: 'Blog (/blog/sample-post)' },
  { pattern: '/:slug', label: 'Plain (/sample-post)' },
  { pattern: '/:year/:month/:slug', label: 'Year and month (/2026/11/sample-post)' },
  { pattern: '/:year/:month/:day/:slug', label: 'Full date (/2026/11/15/sample-post)' },
  { pattern: '/archives/:id', label: 'Numeric (/archives/123)' },
] as const;

export async function fetchSettings(): Promise<SettingsValues> {
  const res = await request('/api/v1/settings');
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { settings: SettingsValues }).settings;
}

export class SettingsError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly field: string | null,
  ) {
    super(status, code);
  }
}

export async function saveSettings(
  patch: Partial<SettingsValues>,
  csrfToken: string,
): Promise<SettingsValues> {
  const res = await request('/api/v1/settings', {
    method: 'PATCH',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    let code = 'request_failed';
    let field: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown; field?: unknown };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.field === 'string') field = body.field;
    } catch {
      // Not JSON; keep the generic code.
    }
    throw new SettingsError(res.status, code, field);
  }
  return ((await res.json()) as { settings: SettingsValues }).settings;
}

/** A published page a person can choose as the front page. */
export interface PageChoice {
  id: number;
  title: string;
}

export async function fetchPublishedPages(): Promise<PageChoice[]> {
  const res = await request(
    '/api/v1/content/page?status=published&limit=100&sort=-updatedAt&fields=id,title',
  );
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { items: PageChoice[] };
  return body.items.map(({ id, title }) => ({ id, title }));
}

/** The draft form values of one screen, as text and flags (inputs hold strings). */
export interface SettingsDraft {
  site_title: string;
  tagline: string;
  timezone: string;
  front_page_id: string; // '' = latest posts
  posts_per_page: string;
  discourage_search_engines: boolean;
  permalink_structure: string;
  api_public_read: boolean;
}

export function toDraft(values: SettingsValues): SettingsDraft {
  return {
    ...values,
    front_page_id: values.front_page_id === null ? '' : String(values.front_page_id),
    posts_per_page: String(values.posts_per_page),
  };
}

/**
 * The changed settings of one screen, as API values. Only keys of `section` that differ from
 * the saved values are included, so an untouched field is never re-sent. A number field that is
 * not a whole number is sent as typed text and refused by the server with a message.
 */
export function diffSettings(
  section: SettingsSection,
  saved: SettingsValues,
  draft: SettingsDraft,
): Partial<SettingsValues> {
  const patch: Record<string, unknown> = {};
  for (const key of SECTION_KEYS[section]) {
    let value: unknown;
    switch (key) {
      case 'site_title':
      case 'tagline':
      case 'permalink_structure':
        value = draft[key].trim();
        break;
      case 'timezone':
        value = draft.timezone;
        break;
      case 'front_page_id':
        value = draft.front_page_id === '' ? null : Number(draft.front_page_id);
        break;
      case 'posts_per_page': {
        const text = draft.posts_per_page.trim();
        value = /^\d{1,6}$/.test(text) ? Number(text) : text;
        break;
      }
      default:
        value = draft[key];
    }
    if (value !== saved[key]) patch[key] = value;
  }
  return patch as Partial<SettingsValues>;
}

/** The IANA time zone names the browser knows, with UTC first; a short list if it cannot say. */
export function timezoneNames(current?: string): string[] {
  let names: string[];
  try {
    names = Intl.supportedValuesOf('timeZone');
  } catch {
    names = [
      'America/New_York',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Berlin',
      'Asia/Tokyo',
    ];
  }
  const all = new Set(['UTC', ...names]);
  if (current) all.add(current);
  return [...all];
}

/** Which preset the pattern is, or `custom`. */
export function presetFor(pattern: string): string {
  return PERMALINK_PRESETS.some((p) => p.pattern === pattern) ? pattern : 'custom';
}

/** A sentence a person can act on, for a settings API error. */
export function describeSettingsError(error: unknown): string {
  if (error instanceof SettingsError && error.code === 'invalid_request') {
    switch (error.field) {
      case 'site_title':
        return 'The site title must be 1 to 200 characters.';
      case 'tagline':
        return 'The tagline can be at most 300 characters.';
      case 'timezone':
        return 'Choose a time zone from the list.';
      case 'front_page_id':
        return 'The front page must be a published page.';
      case 'posts_per_page':
        return `Posts per page must be a whole number from 1 to ${MAX_POSTS_PER_PAGE}.`;
      case 'permalink_structure':
        return 'That permalink pattern is not valid. Start with / and use :slug, :id, :year, :month or :day (use exactly one of :slug or :id).';
    }
    return 'Check the values and try again.';
  }
  if (error instanceof ApiError) {
    if (error.code === 'forbidden') return 'You do not have permission to change settings.';
    if (error.code === 'csrf_failed')
      return 'Your session expired. Reload the page and sign in again.';
  }
  return 'Something went wrong. Please try again.';
}
