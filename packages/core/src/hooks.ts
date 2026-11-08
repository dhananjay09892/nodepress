import { silentLogger, type Logger } from './logger.js';

/**
 * Registry of known action names → the arguments their listeners receive.
 *
 * Plugins and core packages extend this with declaration merging:
 *
 * ```ts
 * declare module '@nodepress/core' {
 *   interface ActionMap {
 *     'shop:order-paid': [order: Order];
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ActionMap {}

/**
 * Registry of known filter names → `{ value, context }`.
 * `value` is what gets transformed; `context` is read-only extra data.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FilterMap {}

export type ActionName = keyof ActionMap | (string & {});
export type FilterName = keyof FilterMap | (string & {});

export type ActionArgs<K> = K extends keyof ActionMap
  ? ActionMap[K] extends unknown[]
    ? ActionMap[K]
    : never
  : unknown[];

export type FilterValue<K> = K extends keyof FilterMap
  ? FilterMap[K] extends { value: infer V }
    ? V
    : never
  : unknown;

export type FilterContext<K> = K extends keyof FilterMap
  ? FilterMap[K] extends { context: infer C }
    ? C
    : undefined
  : unknown;

export type ActionListener<K> = (...args: ActionArgs<K>) => void | Promise<void>;
export type FilterListener<K> = (
  value: FilterValue<K>,
  context: FilterContext<K>,
) => FilterValue<K> | Promise<FilterValue<K>>;

export interface ListenerOptions {
  /** Lower numbers run first. Default 10 (same as WordPress). */
  priority?: number;
  /** Who registered this listener (a plugin name, or "core"). Used for timings and cleanup. */
  source?: string;
}

/** Call to remove the listener that was just added. */
export type Unsubscribe = () => void;

interface Entry {
  fn: (...args: never[]) => unknown;
  priority: number;
  source: string;
  seq: number;
}

export interface HookTiming {
  kind: 'action' | 'filter';
  hook: string;
  source: string;
  calls: number;
  totalMs: number;
  errors: number;
}

export interface HookErrorInfo {
  kind: 'action' | 'filter';
  hook: string;
  source: string;
  error: unknown;
}

export interface HookRegistryOptions {
  logger?: Logger;
  /** Called whenever a listener throws. The error never propagates to the caller. */
  onError?: (info: HookErrorInfo) => void;
  /** Record per-listener timings. Default true. */
  timings?: boolean;
}

/**
 * The hook system at the heart of NodePress.
 *
 * - **Actions** announce that something happened; listeners run side effects.
 * - **Filters** pass a value through each listener, which may return a changed value.
 *
 * Listeners run in priority order (lowest first), then in the order they were added.
 * A listener that throws is logged and skipped; it never breaks the request.
 */
export class HookRegistry {
  #actions = new Map<string, Entry[]>();
  #filters = new Map<string, Entry[]>();
  #timings = new Map<string, HookTiming>();
  #seq = 0;
  #logger: Logger;
  #onError: ((info: HookErrorInfo) => void) | undefined;
  #recordTimings: boolean;

  constructor(options: HookRegistryOptions = {}) {
    this.#logger = options.logger ?? silentLogger;
    this.#onError = options.onError;
    this.#recordTimings = options.timings ?? true;
  }

  // ── Actions ──────────────────────────────────────────────────────────

  addAction<K extends ActionName>(
    name: K,
    listener: ActionListener<K>,
    options: ListenerOptions = {},
  ): Unsubscribe {
    return this.#add(this.#actions, name, listener, options);
  }

  removeAction<K extends ActionName>(name: K, listener: ActionListener<K>): boolean {
    return this.#remove(this.#actions, name, listener);
  }

  hasAction(name: ActionName): boolean {
    return (this.#actions.get(name)?.length ?? 0) > 0;
  }

  /** Run every listener for `name`, one after another, awaiting each. */
  async doAction<K extends ActionName>(name: K, ...args: ActionArgs<K>): Promise<void> {
    const entries = this.#actions.get(name);
    if (!entries || entries.length === 0) return;
    for (const entry of [...entries]) {
      const start = this.#recordTimings ? performance.now() : 0;
      let failed = false;
      try {
        await (entry.fn as (...a: unknown[]) => unknown)(...args);
      } catch (error) {
        failed = true;
        this.#handleError({ kind: 'action', hook: name, source: entry.source, error });
      }
      this.#record('action', name, entry.source, start, failed);
    }
  }

  // ── Filters ──────────────────────────────────────────────────────────

  addFilter<K extends FilterName>(
    name: K,
    listener: FilterListener<K>,
    options: ListenerOptions = {},
  ): Unsubscribe {
    return this.#add(this.#filters, name, listener, options);
  }

  removeFilter<K extends FilterName>(name: K, listener: FilterListener<K>): boolean {
    return this.#remove(this.#filters, name, listener);
  }

  hasFilter(name: FilterName): boolean {
    return (this.#filters.get(name)?.length ?? 0) > 0;
  }

  /**
   * Pass `value` through every listener for `name` and return the result.
   * If a listener throws, its change is discarded and the previous value continues on.
   */
  async applyFilters<K extends FilterName>(
    name: K,
    value: FilterValue<K>,
    ...[context]: undefined extends FilterContext<K>
      ? [context?: FilterContext<K>]
      : [context: FilterContext<K>]
  ): Promise<FilterValue<K>> {
    const entries = this.#filters.get(name);
    if (!entries || entries.length === 0) return value;
    let current = value;
    for (const entry of [...entries]) {
      const start = this.#recordTimings ? performance.now() : 0;
      let failed = false;
      try {
        current = (await (entry.fn as (v: unknown, c: unknown) => unknown)(
          current,
          context,
        )) as FilterValue<K>;
      } catch (error) {
        failed = true;
        this.#handleError({ kind: 'filter', hook: name, source: entry.source, error });
      }
      this.#record('filter', name, entry.source, start, failed);
    }
    return current;
  }

  // ── Housekeeping ─────────────────────────────────────────────────────

  /** Remove every action and filter listener registered with the given source. */
  removeAllFromSource(source: string): number {
    let removed = 0;
    for (const map of [this.#actions, this.#filters]) {
      for (const [name, entries] of map) {
        const kept = entries.filter((e) => e.source !== source);
        removed += entries.length - kept.length;
        if (kept.length === 0) map.delete(name);
        else map.set(name, kept);
      }
    }
    return removed;
  }

  /** Per-listener-source timings, slowest first. Use this to find slow plugins. */
  getTimings(): HookTiming[] {
    return [...this.#timings.values()].map((t) => ({ ...t })).sort((a, b) => b.totalMs - a.totalMs);
  }

  resetTimings(): void {
    this.#timings.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────

  #add(
    map: Map<string, Entry[]>,
    name: string,
    fn: Entry['fn'],
    options: ListenerOptions,
  ): Unsubscribe {
    if (typeof fn !== 'function') {
      throw new TypeError(`Hook listener for "${name}" must be a function`);
    }
    const entry: Entry = {
      fn,
      priority: options.priority ?? 10,
      source: options.source ?? 'core',
      seq: this.#seq++,
    };
    const list = map.get(name) ?? [];
    list.push(entry);
    list.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    map.set(name, list);

    return () => {
      const current = map.get(name);
      if (!current) return;
      const index = current.indexOf(entry);
      if (index === -1) return;
      current.splice(index, 1);
      if (current.length === 0) map.delete(name);
    };
  }

  #remove(map: Map<string, Entry[]>, name: string, fn: Entry['fn']): boolean {
    const list = map.get(name);
    if (!list) return false;
    const index = list.findIndex((e) => e.fn === fn);
    if (index === -1) return false;
    list.splice(index, 1);
    if (list.length === 0) map.delete(name);
    return true;
  }

  #handleError(info: HookErrorInfo): void {
    this.#logger.error(`Listener for ${info.kind} "${info.hook}" from "${info.source}" threw`, {
      error: info.error instanceof Error ? info.error.message : String(info.error),
    });
    try {
      this.#onError?.(info);
    } catch {
      // An error handler must never break dispatch.
    }
  }

  #record(
    kind: 'action' | 'filter',
    hook: string,
    source: string,
    start: number,
    failed: boolean,
  ): void {
    if (!this.#recordTimings) return;
    const key = `${kind}\u0000${hook}\u0000${source}`;
    const t = this.#timings.get(key) ?? { kind, hook, source, calls: 0, totalMs: 0, errors: 0 };
    t.calls += 1;
    t.totalMs += performance.now() - start;
    if (failed) t.errors += 1;
    this.#timings.set(key, t);
  }
}

/**
 * A view of a HookRegistry that tags every listener with one source (e.g. a plugin name),
 * so everything it registered can be removed at once.
 */
export interface ScopedHooks {
  readonly source: string;
  addAction<K extends ActionName>(
    name: K,
    listener: ActionListener<K>,
    options?: Omit<ListenerOptions, 'source'>,
  ): Unsubscribe;
  addFilter<K extends FilterName>(
    name: K,
    listener: FilterListener<K>,
    options?: Omit<ListenerOptions, 'source'>,
  ): Unsubscribe;
  removeAction<K extends ActionName>(name: K, listener: ActionListener<K>): boolean;
  removeFilter<K extends FilterName>(name: K, listener: FilterListener<K>): boolean;
  doAction: HookRegistry['doAction'];
  applyFilters: HookRegistry['applyFilters'];
  hasAction: HookRegistry['hasAction'];
  hasFilter: HookRegistry['hasFilter'];
}

export function scopeHooks(registry: HookRegistry, source: string): ScopedHooks {
  return {
    source,
    addAction: (name, listener, options = {}) =>
      registry.addAction(name, listener, { ...options, source }),
    addFilter: (name, listener, options = {}) =>
      registry.addFilter(name, listener, { ...options, source }),
    removeAction: (name, listener) => registry.removeAction(name, listener),
    removeFilter: (name, listener) => registry.removeFilter(name, listener),
    doAction: registry.doAction.bind(registry),
    applyFilters: registry.applyFilters.bind(registry),
    hasAction: registry.hasAction.bind(registry),
    hasFilter: registry.hasFilter.bind(registry),
  };
}
