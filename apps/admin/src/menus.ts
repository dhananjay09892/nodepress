import { ApiError, request, toError } from './api.js';
import type { MenuItem } from './menu-tree.js';

export interface MenuRecord {
  id: number;
  name: string;
  items: MenuItem[];
}

export interface MenuLocations {
  /** The active theme's locations: name → label. */
  locations: Record<string, string>;
  /** Location name → menu id. */
  assigned: Record<string, number>;
}

/**
 * The saved menus, or `null` when this user may not edit them (no `edit_theme_options`), which
 * also keeps the sidebar entry hidden.
 */
export async function fetchMenus(): Promise<MenuRecord[] | null> {
  const res = await request('/api/v1/menus');
  if (res.status === 403) return null;
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { menus: MenuRecord[] }).menus;
}

export async function fetchMenuLocations(): Promise<MenuLocations> {
  const res = await request('/api/v1/menu-locations');
  if (!res.ok) throw await toError(res);
  return (await res.json()) as MenuLocations;
}

async function send<T>(
  path: string,
  method: string,
  csrfToken: string,
  body?: unknown,
): Promise<T | undefined> {
  const res = await request(path, {
    method,
    headers: { 'x-csrf-token': csrfToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    throw new MenuApiError(error.status, error.code, field, message);
  }
  return res.status === 204 ? undefined : ((await res.json()) as T);
}

/** An API error that may carry the server's `field` and `message` for a refused menu. */
export class MenuApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly field?: string | undefined,
    readonly detail?: string | undefined,
  ) {
    super(status, code);
  }
}

export async function createMenu(name: string, csrfToken: string): Promise<MenuRecord> {
  const body = await send<{ menu: MenuRecord }>('/api/v1/menus', 'POST', csrfToken, { name });
  return body!.menu;
}

export async function updateMenu(
  id: number,
  patch: { name?: string; items?: MenuItem[] },
  csrfToken: string,
): Promise<MenuRecord> {
  const body = await send<{ menu: MenuRecord }>(`/api/v1/menus/${id}`, 'PATCH', csrfToken, patch);
  return body!.menu;
}

export async function deleteMenu(id: number, csrfToken: string): Promise<void> {
  await send(`/api/v1/menus/${id}`, 'DELETE', csrfToken);
}

/** `null` clears a location. The server returns the assignments that now apply. */
export async function saveMenuLocations(
  assignment: Record<string, number | null>,
  csrfToken: string,
): Promise<MenuLocations> {
  return (await send<MenuLocations>('/api/v1/menu-locations', 'PUT', csrfToken, assignment))!;
}

/** Only the locations whose menu changed, as the `PUT` body. */
export function diffLocations(
  saved: Record<string, number>,
  draft: Record<string, number | null>,
): Record<string, number | null> {
  const patch: Record<string, number | null> = {};
  for (const [name, id] of Object.entries(draft)) {
    if ((saved[name] ?? null) !== id) patch[name] = id;
  }
  return patch;
}

/** A sentence a person can act on for a menus API failure. */
export function describeMenuError(error: unknown): string {
  if (error instanceof MenuApiError) {
    if (error.status === 403) return 'You do not have permission to edit menus.';
    if (error.status === 404) return 'That menu no longer exists. Reload the page.';
    if (error.status === 400 && error.detail) return error.detail;
  }
  return 'Something went wrong. Try again.';
}
