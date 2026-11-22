import { ApiError, request, toError } from './api.js';

/** Largest file the server takes (`MAX_EXPORT_BYTES` in `@nodepress/core`). */
export const DEFAULT_MAX_BACKUP_BYTES = 256 * 1024 * 1024;

export interface BackupSummary {
  terms: number;
  content: number;
  menus: number;
  widgets: number;
  redirects: number;
  /** Present when the file held theme settings. */
  themeSettings?: { applied: boolean; reason?: string };
  settingsApplied: string[];
  skipped: Array<{ id: number; title: string; reason: string }>;
  warnings: string[];
}

export class BackupApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly detail?: string | undefined,
  ) {
    super(status, code);
  }
}

/**
 * The size limit when this user may use backups, or `null` when they may not (403) or the site
 * has them off (404); either keeps the sidebar entry hidden.
 */
export async function fetchBackupLimit(): Promise<{ maxBytes: number; media: boolean } | null> {
  const res = await request('/api/v1/backup');
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { maxBytes?: unknown; media?: unknown };
  return {
    maxBytes: typeof body.maxBytes === 'number' ? body.maxBytes : DEFAULT_MAX_BACKUP_BYTES,
    media: body.media === true,
  };
}

export interface MediaRestoreResult {
  imported: number;
  failed: Array<{ id: number; file: string; reason: string }>;
}

/** Whether a chosen file can be sent as a media backup: a non-empty .zip within the limit. */
export function checkMediaFile(
  file: { name: string; size: number },
  maxBytes: number,
): string | null {
  if (!/\.zip$/i.test(file.name)) return 'Choose a .zip file made by NodePress.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > maxBytes) {
    return `That file is too large (${Math.floor(maxBytes / (1024 * 1024))} MB at most).`;
  }
  return null;
}

/** Send a media zip back in. The ids are kept on the server for the next JSON restore. */
export async function restoreMedia(file: Blob, csrfToken: string): Promise<MediaRestoreResult> {
  const res = await request('/api/v1/backup/media', {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-csrf-token': csrfToken },
    body: file,
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
    throw new BackupApiError(error.status, error.code, detail);
  }
  return (await res.json()) as MediaRestoreResult;
}

/** The result of a media restore as sentences. */
export function summarizeMediaRestore(result: MediaRestoreResult): string[] {
  const lines = [`Restored ${count(result.imported, 'file', 'files')}.`];
  if (result.failed.length > 0) {
    lines.push(`${count(result.failed.length, 'file was', 'files were')} not restored.`);
  }
  return lines;
}

/** Send an export file back in. The file is read as text and posted as JSON. */
export async function importBackup(json: string, csrfToken: string): Promise<BackupSummary> {
  const res = await request('/api/v1/backup/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: json,
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
    throw new BackupApiError(error.status, error.code, detail);
  }
  return (await res.json()) as BackupSummary;
}

/** Whether a chosen file can be sent: a JSON file within the server's limit. */
export function checkBackupFile(
  file: { name: string; size: number },
  maxBytes: number,
): string | null {
  if (!/\.json$/i.test(file.name)) return 'Choose a .json file made by NodePress.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > maxBytes) {
    return `That file is too large (${Math.floor(maxBytes / (1024 * 1024))} MB at most).`;
  }
  return null;
}

/** A sentence a person can act on for an import failure. */
export function describeBackupError(error: unknown): string {
  if (error instanceof BackupApiError) {
    switch (error.status) {
      case 400:
        return error.detail ?? 'The server could not use that file.';
      case 403:
        return 'You do not have permission to restore a backup.';
      case 409:
        return 'Another import is still running. Wait for it to finish and try again.';
      case 413:
        return 'That file is too large.';
      case 415:
        return 'Choose a file made by NodePress.';
    }
  }
  return 'Something went wrong. Try again.';
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The numbers as sentences, for the result. */
export function summarizeBackup(summary: BackupSummary): string[] {
  const lines = [
    `Restored ${count(summary.content, 'item', 'items')} and ${count(summary.terms, 'new category or tag', 'new categories and tags')}.`,
  ];
  const extras = [
    summary.menus > 0 ? count(summary.menus, 'menu', 'menus') : null,
    summary.widgets > 0 ? count(summary.widgets, 'widget', 'widgets') : null,
    summary.redirects > 0 ? count(summary.redirects, 'redirect', 'redirects') : null,
  ].filter((part): part is string => part !== null);
  if (extras.length > 0) lines.push(`Also added ${extras.join(', ')}.`);
  if (summary.settingsApplied.length > 0) {
    lines.push(`Settings restored: ${summary.settingsApplied.join(', ')}.`);
  }
  if (summary.themeSettings?.applied) lines.push('Theme settings restored.');
  return lines;
}
