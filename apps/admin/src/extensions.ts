import { ApiError, request, toError } from './api.js';
import type { ReportDefinition } from './report.js';

/** A field of a plugin's settings panel, as the server describes it. */
export interface PanelField {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'select';
  label?: string;
  description?: string;
  required?: boolean;
  /** Select fields only. */
  options?: string[];
  multiline?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
  maxLength?: number;
}

export interface PanelDefinition {
  id: string;
  title: string;
  description?: string;
  fields: PanelField[];
}

export interface ExtensionPageInfo {
  plugin: string;
  id: string;
  title: string;
  description?: string;
  /** Settings panels; empty on a page that only shows a report. */
  panels: PanelDefinition[];
  report?: ReportDefinition;
}

export interface ExtensionMenuItem {
  plugin: string;
  id: string;
  label: string;
  page: string;
}

/** What plugins added to the admin, limited to what the signed-in person may use. */
export interface ExtensionsView {
  menu: ExtensionMenuItem[];
  pages: ExtensionPageInfo[];
}

/** Saved values of every panel on a page, by panel id. */
export type PageValues = Record<string, Record<string, unknown>>;

/** What a form shows: text for everything except checkboxes. */
export type PanelDraft = Record<string, string | boolean>;

export async function fetchExtensions(): Promise<ExtensionsView> {
  const res = await request('/api/v1/admin-extensions');
  if (!res.ok) throw await toError(res);
  return (await res.json()) as ExtensionsView;
}

export async function fetchPageValues(plugin: string, page: string): Promise<PageValues> {
  const res = await request(
    `/api/v1/admin-extensions/${encodeURIComponent(plugin)}/${encodeURIComponent(page)}`,
  );
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { values: PageValues }).values;
}

export class PanelError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly field: string | null,
    readonly detail: string | null,
  ) {
    super(status, code);
  }
}

export async function savePanel(
  plugin: string,
  page: string,
  panel: string,
  patch: Record<string, unknown>,
  csrfToken: string,
): Promise<Record<string, unknown>> {
  const path = [plugin, page, panel].map(encodeURIComponent).join('/');
  const res = await request(`/api/v1/admin-extensions/${path}`, {
    method: 'PATCH',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    let code = 'request_failed';
    let field: string | null = null;
    let detail: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown; field?: unknown; message?: unknown };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.field === 'string') field = body.field;
      if (typeof body.message === 'string') detail = body.message;
    } catch {
      // Not JSON; keep the generic code.
    }
    throw new PanelError(res.status, code, field, detail);
  }
  return ((await res.json()) as { values: Record<string, unknown> }).values;
}

/** The label a field is shown with: its label, or its name with underscores as spaces. */
export function fieldLabel(field: PanelField): string {
  if (field.label) return field.label;
  const text = field.name.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Form state for a panel from its saved values. */
export function toPanelDraft(
  fields: readonly PanelField[],
  values: Record<string, unknown> | undefined,
): PanelDraft {
  const draft: PanelDraft = {};
  for (const field of fields) {
    const value = values?.[field.name];
    if (field.type === 'boolean') draft[field.name] = value === true;
    else if (typeof value === 'string') draft[field.name] = value;
    else if (typeof value === 'number') draft[field.name] = String(value);
    else draft[field.name] = '';
  }
  return draft;
}

/**
 * Only the fields the person changed, ready to send. An emptied field is sent as `null`, which
 * puts it back to its default. A number that is not a number is sent as the text typed, so the
 * server refuses it with a message instead of the field being silently cleared.
 */
export function diffPanel(
  fields: readonly PanelField[],
  saved: Record<string, unknown> | undefined,
  draft: PanelDraft,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const before = toPanelDraft(fields, saved);
  for (const field of fields) {
    const now = draft[field.name];
    if (now === undefined || now === before[field.name]) continue;
    if (field.type === 'boolean') {
      patch[field.name] = now === true;
    } else if (typeof now === 'string') {
      const text = field.type === 'number' ? now.trim() : now;
      if (text === '') patch[field.name] = null;
      else if (field.type === 'number') {
        const number = Number(text);
        patch[field.name] = Number.isFinite(number) ? number : text;
      } else patch[field.name] = text;
    }
  }
  return patch;
}

/** A sentence a person can act on, for a failed save. */
export function describePanelError(error: unknown, fields: readonly PanelField[] = []): string {
  if (error instanceof PanelError) {
    if (error.code === 'invalid_request') {
      const field = fields.find((f) => f.name === error.field);
      const name = field ? fieldLabel(field) : error.field;
      return name && error.detail
        ? `${name}: ${error.detail}`
        : 'The server rejected a value you entered. Check the fields and try again.';
    }
    if (error.status === 403) return 'You do not have permission to change these settings.';
    if (error.status === 404) return 'This page is no longer available. Reload the admin.';
  }
  if (error instanceof ApiError) return 'Something went wrong. Please try again.';
  return 'Could not reach the server. Check your connection and try again.';
}
