import { ApiError, request, toError } from './api.js';

export interface RedirectRule {
  id: number;
  from: string;
  to: string;
  status: 301 | 302;
}

export interface CsvImportReport {
  created: number;
  updated: number;
  errors: Array<{ line: number; message: string }>;
}

/** An API error that may carry the server's `field` and `message` for a refused rule. */
export class RedirectApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly field?: string | undefined,
    readonly detail?: string | undefined,
  ) {
    super(status, code);
  }
}

async function failure(res: Response): Promise<RedirectApiError> {
  let field: string | undefined;
  let detail: string | undefined;
  try {
    const data = (await res.clone().json()) as { field?: unknown; message?: unknown };
    if (typeof data.field === 'string') field = data.field;
    if (typeof data.message === 'string') detail = data.message;
  } catch {
    // Not JSON; the generic code is enough.
  }
  const error = await toError(res);
  return new RedirectApiError(error.status, error.code, field, detail);
}

/** The saved rules, or `null` when this user may not manage them (no `manage_options`). */
export async function fetchRedirects(): Promise<RedirectRule[] | null> {
  const res = await request('/api/v1/redirects');
  if (res.status === 403) return null;
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { redirects: RedirectRule[] }).redirects;
}

export async function createRedirect(
  rule: { from: string; to: string; status: number },
  csrfToken: string,
): Promise<RedirectRule> {
  const res = await request('/api/v1/redirects', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify(rule),
  });
  if (!res.ok) throw await failure(res);
  return ((await res.json()) as { redirect: RedirectRule }).redirect;
}

export async function updateRedirect(
  id: number,
  patch: Partial<{ from: string; to: string; status: number }>,
  csrfToken: string,
): Promise<RedirectRule> {
  const res = await request(`/api/v1/redirects/${id}`, {
    method: 'PATCH',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await failure(res);
  return ((await res.json()) as { redirect: RedirectRule }).redirect;
}

export async function deleteRedirect(id: number, csrfToken: string): Promise<void> {
  const res = await request(`/api/v1/redirects/${id}`, {
    method: 'DELETE',
    headers: { 'x-csrf-token': csrfToken },
  });
  if (!res.ok) throw await failure(res);
}

export const MAX_CSV_BYTES = 1024 * 1024;

export async function importRedirectsCsv(
  text: string,
  csrfToken: string,
): Promise<CsvImportReport> {
  const res = await request('/api/v1/redirects/import', {
    method: 'POST',
    headers: { 'content-type': 'text/csv', 'x-csrf-token': csrfToken },
    body: text,
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as CsvImportReport;
}

/** One CSV field, quoted when it holds a comma, a quote or a line break. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The rules as a CSV file the import accepts (`from,to,status` with a header row). */
export function redirectsToCsv(rules: readonly RedirectRule[]): string {
  const lines = [
    'from,to,status',
    ...rules.map((r) => [r.from, r.to, String(r.status)].map(csvField).join(',')),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** A sentence a person can act on for a redirects API failure. */
export function describeRedirectError(error: unknown): string {
  if (error instanceof RedirectApiError) {
    if (error.status === 403) return 'You do not have permission to manage redirects.';
    if (error.status === 404) return 'That redirect no longer exists. Reload the page.';
    if (error.status === 413) return 'That file is too large (1 MB at most).';
    if (error.status === 415) return 'Choose a CSV file.';
    if (error.status === 400 && error.detail) return error.detail;
  }
  return 'Something went wrong. Try again.';
}

/** The fields that differ from the saved rule, as the `PATCH` body. */
export function diffRedirect(
  saved: RedirectRule,
  draft: { from: string; to: string; status: number },
): Partial<{ from: string; to: string; status: number }> {
  const patch: Partial<{ from: string; to: string; status: number }> = {};
  if (draft.from.trim() !== saved.from) patch.from = draft.from.trim();
  if (draft.to.trim() !== saved.to) patch.to = draft.to.trim();
  if (draft.status !== saved.status) patch.status = draft.status;
  return patch;
}
