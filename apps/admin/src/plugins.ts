import { ApiError, request, toError } from './api.js';

export interface PluginPackage {
  name: string;
  version: string;
  title: string;
  description?: string | undefined;
  permissions: string[];
  hasMigrations: boolean;
  /** The owner's choice; it applies when the site restarts. */
  enabled: boolean;
  /** How the running site treats it (absent when it was not loaded). */
  status?: 'registered' | 'active' | 'inactive' | 'failed' | undefined;
  error?: string | undefined;
}

export interface PluginsOverview {
  plugins: PluginPackage[];
  broken: Array<{ folder: string; message: string }>;
  restartRequired: boolean;
}

/** What each declared permission lets a plugin do, in words for the site owner. */
export const PERMISSION_LABELS: Record<string, string> = {
  'content:read': 'Read posts and pages',
  'content:write': 'Create and change posts and pages',
  'media:read': 'Read the media library',
  'media:write': 'Add and change media',
  'users:read': 'Read the list of users',
  'options:read': 'Read site settings',
  'options:write': 'Change site settings',
  network: 'Connect to other websites',
  jobs: 'Run background jobs',
  admin: 'Add pages and menu items to this admin',
  database: 'Create and change its own database tables',
};

export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission;
}

/**
 * The installed packages, or `null` when this user may not manage plugins (no `manage_plugins`),
 * which also keeps the sidebar entry hidden.
 */
export async function fetchPlugins(): Promise<PluginsOverview | null> {
  const res = await request('/api/v1/plugins');
  if (res.status === 403) return null;
  if (!res.ok) throw await toError(res);
  return (await res.json()) as PluginsOverview;
}

/** An API error that carries the server's message for a refused package. */
export class PluginApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly detail?: string | undefined,
  ) {
    super(status, code);
  }
}

async function failure(res: Response): Promise<PluginApiError> {
  let detail: string | undefined;
  try {
    const data = (await res.clone().json()) as { message?: unknown };
    if (typeof data.message === 'string') detail = data.message;
  } catch {
    // Not JSON; the generic code is enough.
  }
  const error = await toError(res);
  return new PluginApiError(error.status, error.code, detail);
}

/** Upload a `.zip` package. It is installed but stays off until enabled. */
export async function uploadPlugin(file: Blob, csrfToken: string): Promise<PluginsOverview> {
  const res = await request('/api/v1/plugins', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/zip' },
    body: file,
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as PluginsOverview;
}

export async function setPluginEnabled(
  name: string,
  enabled: boolean,
  csrfToken: string,
): Promise<PluginsOverview> {
  const res = await request(`/api/v1/plugins/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as PluginsOverview;
}

/** A sentence a person can act on for a plugins API failure. */
export function describePluginError(error: unknown): string {
  if (error instanceof PluginApiError) {
    switch (error.code) {
      case 'invalid_plugin':
        return error.detail ?? 'That package is not a valid plugin.';
      case 'payload_too_large':
        return 'That file is too large (the limit is 20 MB).';
      case 'unsupported_media_type':
        return 'Upload a .zip file.';
      case 'forbidden':
        return 'You do not have permission to manage plugins.';
      case 'not_found':
        return 'That plugin is no longer installed. Reload the page.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }
  return 'Could not reach the server. Check your connection and try again.';
}

/** One line for a package's state, as shown on its card. */
export function statusLabel(plugin: PluginPackage): string {
  if (plugin.status === 'failed') return 'Failed to start';
  if (plugin.enabled) return plugin.status === 'active' ? 'On' : 'On after restart';
  return plugin.status === 'active' ? 'Off after restart' : 'Off';
}
