import { ApiError, request, toError } from './api.js';
import type { WidgetInstance, WidgetTypeInfo } from './widget-list.js';

export interface WidgetsOverview {
  /** The active theme's widget areas: name → label. */
  areas: Record<string, string>;
  widgets: Record<string, WidgetInstance[]>;
  types: WidgetTypeInfo[];
}

/** An API error that may carry the server's `field` and `message` for refused widgets. */
export class WidgetApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly field?: string | undefined,
    readonly detail?: string | undefined,
  ) {
    super(status, code);
  }
}

/**
 * The areas, widgets and types, or `null` when this user may not edit widgets
 * (no `edit_theme_options`), which also keeps the sidebar entry hidden.
 */
export async function fetchWidgets(): Promise<WidgetsOverview | null> {
  const res = await request('/api/v1/widgets');
  if (res.status === 403) return null;
  if (!res.ok) throw await toError(res);
  return (await res.json()) as WidgetsOverview;
}

/** Replace the widgets of the areas named in `areas`; the server returns the new overview. */
export async function saveWidgets(
  areas: Record<string, WidgetInstance[]>,
  csrfToken: string,
): Promise<WidgetsOverview> {
  const res = await request('/api/v1/widgets', {
    method: 'PUT',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify(areas),
  });
  if (!res.ok) {
    let field: string | undefined;
    let message: string | undefined;
    try {
      const data = (await res.clone().json()) as { field?: unknown; message?: unknown };
      if (typeof data.field === 'string') field = data.field;
      if (typeof data.message === 'string') message = data.message;
    } catch {
      // Not JSON; the generic code is enough.
    }
    const error = await toError(res);
    throw new WidgetApiError(error.status, error.code, field, message);
  }
  return (await res.json()) as WidgetsOverview;
}

/** A sentence a person can act on for a widgets API failure. */
export function describeWidgetError(error: unknown): string {
  if (error instanceof WidgetApiError) {
    if (error.status === 403) return 'You do not have permission to edit widgets.';
    if (error.status === 400 && error.detail) return error.detail;
  }
  return 'Something went wrong. Try again.';
}
