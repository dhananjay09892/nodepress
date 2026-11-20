export type DatabaseKind = 'sqlite' | 'postgres' | 'libsql';

export interface SiteOptions {
  /** Folder name, also the package name: lowercase letters, digits and hyphens. */
  directory: string;
  siteName: string;
  adminEmail: string;
  adminPassword: string;
  /** `file:./nodepress.db`, `postgres://…` or `libsql://…`. */
  databaseUrl: string;
  /** Turso token, only for `libsql://`. */
  databaseAuthToken?: string | undefined;
  port: number;
  /** Public address of the site, for example `https://example.com`. Optional. */
  siteUrl?: string | undefined;
  /** Absolute path of a built NodePress checkout whose server this site runs. */
  from: string;
}

export class InstallError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

export const MIN_PASSWORD_LENGTH = 12;
export const DEFAULT_DATABASE_URL = 'file:./nodepress.db';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function validateDirectory(value: string): string {
  const name = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new InstallError(
      'directory',
      'Use lowercase letters, digits and hyphens, starting with a letter or digit (at most 64 characters).',
    );
  }
  return name;
}

export function validateSiteName(value: string): string {
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || name.length > 100 || CONTROL.test(name)) {
    throw new InstallError('siteName', 'Enter a site name of up to 100 characters.');
  }
  return name;
}

export function validateEmail(value: string): string {
  const email = value.trim();
  if (
    email.length > 254 ||
    /[\s<>(),;:\\"\u0000-\u001f\u007f]/.test(email) ||
    !/^[^@]+@[^@.][^@]*\.[^@.]+$/.test(email)
  ) {
    throw new InstallError('adminEmail', 'Enter a valid email address.');
  }
  return email;
}

export function validatePassword(value: string): string {
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new InstallError('adminPassword', `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (value.length > 200 || CONTROL.test(value)) {
    throw new InstallError('adminPassword', 'The password has characters that cannot be used.');
  }
  return value;
}

/** A database address NodePress understands: SQLite file, PostgreSQL or libSQL (Turso). */
export function validateDatabaseUrl(value: string): { url: string; kind: DatabaseKind } {
  const url = value.trim() || DEFAULT_DATABASE_URL;
  if (CONTROL.test(url) || /\s/.test(url)) {
    throw new InstallError('databaseUrl', 'The database address cannot contain spaces.');
  }
  if (url.startsWith('file:') && url.length > 5) return { url, kind: 'sqlite' };
  if (/^postgres(?:ql)?:\/\/[^/]+\/.+/.test(url)) return { url, kind: 'postgres' };
  if (/^libsql:\/\/.+/.test(url)) return { url, kind: 'libsql' };
  throw new InstallError(
    'databaseUrl',
    'Use file:./nodepress.db, postgres://user:password@host:5432/name or libsql://name.turso.io.',
  );
}

export function validatePort(value: string | number): number {
  const port = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InstallError('port', 'Enter a port between 1 and 65535.');
  }
  return port;
}

/** `https://example.com` for an http(s) address (path dropped); empty input means none. */
export function validateSiteUrl(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {
    // falls through to the error below
  }
  throw new InstallError('siteUrl', 'Enter an http(s) address like https://example.com, or leave it empty.');
}
