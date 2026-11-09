import type { HookRegistry } from './hooks.js';

/**
 * Typed option keys. Core and plugins extend this with declaration merging so
 * `options.get('site_name')` knows its value type:
 *
 * ```ts
 * declare module '@nodepress/core' {
 *   interface OptionMap {
 *     'shop:currency': string;
 *   }
 * }
 * ```
 *
 * Keys that are not declared still work and are typed `unknown`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OptionMap {}

export type OptionKey = keyof OptionMap | (string & {});
export type OptionValue<K> = K extends keyof OptionMap ? OptionMap[K] : unknown;

declare module './hooks.js' {
  interface ActionMap {
    /** An option was created or changed. `oldValue` is `undefined` for a new option. */
    'option:updated': [key: string, newValue: unknown, oldValue: unknown];
    /** An option was deleted. */
    'option:deleted': [key: string, oldValue: unknown];
  }
  interface FilterMap {
    /** Every value returned by `options.get()` (including the fallback) passes through here. */
    'option:value': { value: unknown; context: { key: string } };
  }
}

/** One row of the `options` table. */
export interface OptionRow {
  key: string;
  value: unknown;
  autoload: boolean;
}

/** Storage behind the options service. `@nodepress/db` provides `createOptionsStore()`. */
export interface OptionsStore {
  /** Every row with `autoload = true`. */
  getAutoloaded(): Promise<OptionRow[]>;
  get(key: string): Promise<OptionRow | undefined>;
  /** Insert or replace the row for `row.key`. */
  upsert(row: OptionRow): Promise<void>;
  /** Returns true if a row was removed. */
  delete(key: string): Promise<boolean>;
}

export interface SetOptionOptions {
  /**
   * Load this option with the rest at startup (site name, permalinks…).
   * Defaults to the option's current setting, or `true` for a new option.
   */
  autoload?: boolean;
}

export interface OptionsServiceOptions {
  store: OptionsStore;
  hooks: HookRegistry;
}

interface CacheEntry {
  value: unknown;
  autoload: boolean;
}

/**
 * Read and write site options (settings) stored in the `options` table.
 *
 * - Autoloaded options are read once into memory by `load()`; others are read on first use.
 * - Values must be JSON-serialisable. They are copied on the way in and out, so callers can
 *   never mutate the cache by accident.
 * - `option:value` filters every value returned by `get()`; `option:updated` fires after a change.
 */
export class OptionsService {
  readonly #store: OptionsStore;
  readonly #hooks: HookRegistry;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #missing = new Set<string>();
  #loaded: Promise<void> | undefined;

  constructor(options: OptionsServiceOptions) {
    this.#store = options.store;
    this.#hooks = options.hooks;
  }

  /** Load all autoloaded options into the cache. Called automatically; safe to call again. */
  load(): Promise<void> {
    this.#loaded ??= this.#store.getAutoloaded().then(
      (rows) => {
        for (const row of rows) {
          // A set() that raced with load() is newer than what we just read.
          if (!this.#cache.has(row.key)) this.#cache.set(row.key, toEntry(row));
        }
      },
      (error: unknown) => {
        this.#loaded = undefined; // allow a retry
        throw error;
      },
    );
    return this.#loaded;
  }

  /** Drop everything cached, e.g. after another process changed the table. */
  async reload(): Promise<void> {
    this.#cache.clear();
    this.#missing.clear();
    this.#loaded = undefined;
    await this.load();
  }

  /** Get an option, or `fallback` (default `undefined`) when it does not exist. */
  async get<K extends OptionKey>(key: K): Promise<OptionValue<K> | undefined>;
  async get<K extends OptionKey>(key: K, fallback: OptionValue<K>): Promise<OptionValue<K>>;
  async get(key: string, fallback?: unknown): Promise<unknown> {
    assertKey(key);
    const entry = await this.#find(key);
    const value = entry ? clone(entry.value) : fallback;
    return this.#hooks.applyFilters('option:value', value, { key });
  }

  async has(key: string): Promise<boolean> {
    assertKey(key);
    return (await this.#find(key)) !== undefined;
  }

  /** Copy of every autoloaded option, as `{ key: value }`. Values are not filtered. */
  async getAutoloaded(): Promise<Record<string, unknown>> {
    await this.load();
    const result: Record<string, unknown> = {};
    for (const [key, entry] of this.#cache) {
      if (entry.autoload) result[key] = clone(entry.value);
    }
    return result;
  }

  /**
   * Create or change an option. Returns `true` if something changed; setting an identical
   * value is a no-op that fires no hook.
   */
  async set<K extends OptionKey>(
    key: K,
    value: OptionValue<K>,
    options: SetOptionOptions = {},
  ): Promise<boolean> {
    assertKey(key);
    const stored = toJsonValue(key, value);
    const existing = await this.#find(key);
    const autoload = options.autoload ?? existing?.autoload ?? true;

    if (existing && existing.autoload === autoload && sameJson(existing.value, stored)) {
      return false;
    }

    await this.#store.upsert({ key, value: stored, autoload });
    this.#cache.set(key, { value: stored, autoload });
    this.#missing.delete(key);
    await this.#hooks.doAction('option:updated', key, clone(stored), clone(existing?.value));
    return true;
  }

  /** Delete an option. Returns `true` if it existed. */
  async delete(key: string): Promise<boolean> {
    assertKey(key);
    const existing = await this.#find(key);
    const removed = await this.#store.delete(key);
    this.#cache.delete(key);
    this.#missing.add(key);
    if (removed) await this.#hooks.doAction('option:deleted', key, clone(existing?.value));
    return removed;
  }

  async #find(key: string): Promise<CacheEntry | undefined> {
    await this.load();
    const cached = this.#cache.get(key);
    if (cached) return cached;
    if (this.#missing.has(key)) return undefined;

    const row = await this.#store.get(key);
    if (!row) {
      this.#missing.add(key);
      return undefined;
    }
    // Do not overwrite a value a concurrent set() cached while we were reading.
    const entry = this.#cache.get(key) ?? toEntry(row);
    this.#cache.set(key, entry);
    return entry;
  }
}

export function createOptionsService(options: OptionsServiceOptions): OptionsService {
  return new OptionsService(options);
}

function assertKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('Option key must be a non-empty string');
  }
}

/** Normalise to what a JSON column returns, and reject values that cannot be stored. */
function toJsonValue(key: string, value: unknown): unknown {
  if (value === undefined) {
    throw new TypeError(`Option "${key}" cannot be undefined; use null or delete() instead`);
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(
      `Option "${key}" is not JSON-serialisable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (json === undefined) {
    throw new TypeError(`Option "${key}" is not JSON-serialisable (functions and symbols)`);
  }
  return JSON.parse(json) as unknown;
}

function toEntry(row: OptionRow): CacheEntry {
  return { value: row.value === undefined ? null : row.value, autoload: row.autoload };
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
