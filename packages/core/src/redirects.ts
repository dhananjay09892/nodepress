import type { OptionsService } from './options.js';

declare module './options.js' {
  interface OptionMap {
    /** Redirect rules managed by the site owner (see `RedirectsService`). */
    redirects: StoredRedirects;
  }
}

export const MAX_REDIRECTS = 5000;
export const MAX_PATH_LENGTH = 500;
export const MAX_TARGET_LENGTH = 2000;
export const MAX_CSV_BYTES = 1024 * 1024;
const MAX_HOPS = 10;

export type RedirectStatus = 301 | 302;

export interface Redirect {
  id: number;
  /** Request path to redirect, for example `/old-page`. A trailing `*` matches any ending. */
  from: string;
  /** Where to send the visitor: a site path or an `http(s)` URL. With a `*` in `from`, a `*` here is replaced by what the wildcard matched. */
  to: string;
  status: RedirectStatus;
}

export interface StoredRedirects {
  nextId: number;
  redirects: Redirect[];
}

export class RedirectValidationError extends Error {
  constructor(
    readonly field: 'from' | 'to' | 'status' | 'csv',
    message: string,
  ) {
    super(message);
    this.name = 'RedirectValidationError';
  }
}

export class RedirectNotFoundError extends Error {
  constructor(readonly id: number) {
    super(`Redirect ${id} does not exist`);
    this.name = 'RedirectNotFoundError';
  }
}

export interface RedirectImportReport {
  created: number;
  updated: number;
  /** Rows that were refused, by line number (1 = first line of the file). */
  errors: Array<{ line: number; message: string }>;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Paths owned by the system; a redirect there would lock the owner out. */
const RESERVED = ['/api', '/admin', '/uploads'];

/** Trim, require a leading slash, drop a trailing slash (except for `/`). Query strings are not allowed. */
export function normalizeFrom(value: unknown): string {
  if (typeof value !== 'string') throw new RedirectValidationError('from', 'Enter the old path.');
  let from = value.trim();
  if (!from.startsWith('/') || from.startsWith('//')) {
    throw new RedirectValidationError('from', 'The old path must start with a single "/".');
  }
  if (CONTROL.test(from) || /[?#\s]/.test(from)) {
    throw new RedirectValidationError('from', 'The old path cannot contain spaces, "?" or "#".');
  }
  if (from.length > MAX_PATH_LENGTH) {
    throw new RedirectValidationError('from', `Use at most ${MAX_PATH_LENGTH} characters.`);
  }
  const star = from.indexOf('*');
  if (star !== -1 && star !== from.length - 1) {
    throw new RedirectValidationError('from', 'A "*" is only allowed at the end.');
  }
  if (from.length > 1 && from.endsWith('/')) from = from.slice(0, -1);
  if (from === '/') {
    throw new RedirectValidationError('from', 'The front page cannot be redirected.');
  }
  const base = from.endsWith('*') ? from.slice(0, -1) : from;
  if (RESERVED.some((r) => base === r || base.startsWith(`${r}/`))) {
    throw new RedirectValidationError('from', 'Paths under /api, /admin and /uploads cannot be redirected.');
  }
  return from;
}

/** A site path (single leading slash) or an `http(s)` URL; no control characters or spaces. */
export function normalizeTo(value: unknown): string {
  if (typeof value !== 'string') throw new RedirectValidationError('to', 'Enter the new address.');
  const to = value.trim();
  if (!to) throw new RedirectValidationError('to', 'Enter the new address.');
  if (to.length > MAX_TARGET_LENGTH) {
    throw new RedirectValidationError('to', `Use at most ${MAX_TARGET_LENGTH} characters.`);
  }
  if (CONTROL.test(to) || /\s/.test(to)) {
    throw new RedirectValidationError('to', 'The new address cannot contain spaces.');
  }
  if (to.startsWith('/')) {
    if (to.startsWith('//') || to.includes('\\')) {
      throw new RedirectValidationError('to', 'Use a path like /new-page or a full http(s) URL.');
    }
    return to;
  }
  try {
    const url = new URL(to);
    if (url.protocol === 'http:' || url.protocol === 'https:') return to;
  } catch {
    // falls through to the error below
  }
  throw new RedirectValidationError('to', 'Use a path like /new-page or a full http(s) URL.');
}

function normalizeStatus(value: unknown): RedirectStatus {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (n === 301 || n === 302) return n;
  throw new RedirectValidationError('status', 'The status must be 301 (permanent) or 302 (temporary).');
}

/** The path part of a target that stays on this site, or `undefined` for another site. */
function localPath(to: string): string | undefined {
  return to.startsWith('/') ? to.split(/[?#]/)[0] : undefined;
}

/** A row of CSV cells and the line of the file it started on (1 = first line). */
export interface CsvRow {
  cells: string[];
  line: number;
}

/**
 * Split CSV text into rows. Handles quoted cells (`""` is an escaped quote, line breaks inside
 * quotes stay in the cell), LF, CRLF and CR line ends, and a leading BOM. Blank lines are skipped.
 * The separator is always a comma.
 */
export function parseCsvRows(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;
  let line = 1;
  let rowLine = 1;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const endRow = () => {
    row.push(cell);
    rows.push({ cells: row, line: rowLine });
    row = [];
    cell = '';
    started = false;
  };
  const begin = () => {
    if (!started && cell === '' && row.length === 0) rowLine = line;
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      begin();
      quoted = true;
      started = true;
    } else if (ch === ',') {
      begin();
      row.push(cell);
      cell = '';
      started = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      if (started || cell !== '' || row.length > 0) endRow();
      line++;
    } else {
      begin();
      cell += ch;
      started = true;
    }
  }
  if (quoted) throw new RedirectValidationError('csv', 'A quoted cell is not closed.');
  if (started || cell !== '' || row.length > 0) endRow();
  return rows;
}

/** Just the cells of each non-blank row (see `parseCsvRows`). */
export function parseCsv(text: string): string[][] {
  return parseCsvRows(text).map((r) => r.cells);
}

export interface RedirectsServiceOptions {
  options: Pick<OptionsService, 'get' | 'set'>;
}

/**
 * Redirect rules for the site owner: 301 (permanent) or 302 (temporary) from an old path to a
 * new path or URL, with an optional trailing `*` wildcard, managed one by one or imported from CSV.
 * Rules live in the (not autoloaded) `redirects` option. A rule that would start a loop is refused.
 */
export class RedirectsService {
  readonly #options: RedirectsServiceOptions['options'];
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: RedirectsServiceOptions) {
    this.#options = options.options;
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #load(): Promise<StoredRedirects> {
    const stored = await this.#options.get('redirects');
    return stored && Array.isArray(stored.redirects)
      ? { nextId: stored.nextId, redirects: stored.redirects }
      : { nextId: 1, redirects: [] };
  }

  async #save(stored: StoredRedirects): Promise<void> {
    await this.#options.set('redirects', stored, { autoload: false });
  }

  async list(): Promise<Redirect[]> {
    return (await this.#load()).redirects.map((r) => ({ ...r }));
  }

  async get(id: number): Promise<Redirect | undefined> {
    return (await this.list()).find((r) => r.id === id);
  }

  create(input: { from: unknown; to: unknown; status?: unknown }): Promise<Redirect> {
    return this.#serial(async () => {
      const stored = await this.#load();
      const rule = this.#validate(stored, undefined, input);
      const created: Redirect = { id: stored.nextId, ...rule };
      await this.#save({ nextId: stored.nextId + 1, redirects: [...stored.redirects, created] });
      return created;
    });
  }

  update(id: number, input: { from?: unknown; to?: unknown; status?: unknown }): Promise<Redirect> {
    return this.#serial(async () => {
      const stored = await this.#load();
      const current = stored.redirects.find((r) => r.id === id);
      if (!current) throw new RedirectNotFoundError(id);
      const rule = this.#validate(stored, id, {
        from: input.from ?? current.from,
        to: input.to ?? current.to,
        status: input.status ?? current.status,
      });
      const updated: Redirect = { id, ...rule };
      await this.#save({
        nextId: stored.nextId,
        redirects: stored.redirects.map((r) => (r.id === id ? updated : r)),
      });
      return updated;
    });
  }

  delete(id: number): Promise<void> {
    return this.#serial(async () => {
      const stored = await this.#load();
      if (!stored.redirects.some((r) => r.id === id)) throw new RedirectNotFoundError(id);
      await this.#save({
        nextId: stored.nextId,
        redirects: stored.redirects.filter((r) => r.id !== id),
      });
    });
  }

  /**
   * Import `from,to[,status]` rows (a header row is skipped). A row for an old path that already
   * has a rule replaces it. Bad rows are reported by line and skipped; the rest are kept.
   */
  importCsv(text: string): Promise<RedirectImportReport> {
    return this.#serial(async () => {
      if (Buffer.byteLength(text) > MAX_CSV_BYTES) {
        throw new RedirectValidationError('csv', 'The file is too large (1 MB at most).');
      }
      const rows = parseCsvRows(text);
      const stored = await this.#load();
      let { nextId } = stored;
      let rules = [...stored.redirects];
      const report: RedirectImportReport = { created: 0, updated: 0, errors: [] };
      rows.forEach(({ cells, line }, index) => {
        if (index === 0 && /^from$/i.test((cells[0] ?? '').trim())) return;
        if (cells.every((c) => c.trim() === '')) return;
        try {
          if (cells.length < 2 || cells.length > 3) {
            throw new RedirectValidationError('csv', 'Use two or three columns: from, to, status.');
          }
          const input = { from: cells[0], to: cells[1], status: cells[2] ?? 301 };
          const existing = rules.find((r) => {
            try {
              return r.from === normalizeFrom(input.from);
            } catch {
              return false;
            }
          });
          const draft: StoredRedirects = { nextId, redirects: rules };
          const rule = this.#validate(draft, existing?.id, input);
          if (existing) {
            rules = rules.map((r) => (r.id === existing.id ? { id: r.id, ...rule } : r));
            report.updated++;
          } else {
            if (rules.length >= MAX_REDIRECTS) {
              throw new RedirectValidationError('csv', `At most ${MAX_REDIRECTS} redirects are allowed.`);
            }
            rules = [...rules, { id: nextId++, ...rule }];
            report.created++;
          }
        } catch (error) {
          if (!(error instanceof RedirectValidationError)) throw error;
          report.errors.push({ line, message: error.message });
        }
      });
      if (report.created + report.updated > 0) await this.#save({ nextId, redirects: rules });
      return report;
    });
  }

  /** The rule for a request path (no query string), or `undefined`. Exact rules beat wildcards; the longest wildcard wins. */
  async match(path: string): Promise<{ to: string; status: RedirectStatus } | undefined> {
    const { redirects } = await this.#load();
    return matchRule(redirects, path);
  }

  #validate(
    stored: StoredRedirects,
    ignoreId: number | undefined,
    input: { from: unknown; to: unknown; status?: unknown },
  ): Omit<Redirect, 'id'> {
    const from = normalizeFrom(input.from);
    const to = normalizeTo(input.to);
    const status = normalizeStatus(input.status ?? 301);
    const others = stored.redirects.filter((r) => r.id !== ignoreId);
    if (others.some((r) => r.from === from)) {
      throw new RedirectValidationError('from', 'There is already a redirect for this path.');
    }
    if (ignoreId === undefined && others.length >= MAX_REDIRECTS) {
      throw new RedirectValidationError('from', `At most ${MAX_REDIRECTS} redirects are allowed.`);
    }
    if (to.includes('*') && !from.endsWith('*')) {
      throw new RedirectValidationError('to', 'A "*" in the new address needs a "*" at the end of the old path.');
    }
    const target = localPath(to);
    const rule: Redirect = { id: ignoreId ?? -1, from, to, status };
    if (target !== undefined && loops([...others, rule], rule)) {
      throw new RedirectValidationError('to', 'This redirect would send visitors in a loop.');
    }
    return { from, to, status };
  }
}

function matchRule(
  redirects: Redirect[],
  path: string,
): { to: string; status: RedirectStatus } | undefined {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const exact = redirects.find((r) => !r.from.endsWith('*') && r.from === normalized);
  if (exact) return { to: exact.to, status: exact.status };
  let best: Redirect | undefined;
  for (const r of redirects) {
    if (!r.from.endsWith('*')) continue;
    const prefix = r.from.slice(0, -1);
    if (normalized.startsWith(prefix) && (!best || prefix.length > best.from.length - 1)) best = r;
  }
  if (!best) return undefined;
  const rest = normalized.slice(best.from.length - 1);
  const to = best.to.replace('*', () => rest);
  // What the wildcard matched must not turn a site path into another site (`//host`, `/\host`).
  if (to.startsWith('/') && (to.startsWith('//') || to.includes('\\'))) return undefined;
  return { to, status: best.status };
}

/** Whether following `start` through the rules ever comes back to a path already visited. */
function loops(redirects: Redirect[], start: Redirect): boolean {
  const seen = new Set<string>();
  let current: { to: string } | undefined = start;
  for (let hop = 0; hop < MAX_HOPS && current; hop++) {
    const path = localPath(current.to);
    if (path === undefined) return false;
    if (seen.has(path)) return true;
    seen.add(path);
    current = matchRule(redirects, path);
  }
  return current !== undefined;
}

export function createRedirects(options: RedirectsServiceOptions): RedirectsService {
  return new RedirectsService(options);
}
