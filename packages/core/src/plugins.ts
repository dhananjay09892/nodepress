import { AdminExtensions, type ScopedAdmin } from './admin-extensions.js';
import type { WidgetTypeDefinition } from './widgets.js';
import { scopeHooks, type HookRegistry, type ScopedHooks } from './hooks.js';
import type { JobQueue, ScopedJobs } from './jobs.js';
import type { Logger } from './logger.js';
import {
  createPluginDatabase,
  type ParameterizedSqlRunner,
  type PluginDatabase,
} from './plugin-db.js';
import { PluginRouteRegistry, type ScopedPluginRoutes } from './plugin-routes.js';

export interface PluginContext {
  /** Hooks scoped to this plugin: everything added here is removed on deactivation. */
  hooks: ScopedHooks;
  /** Logger prefixed with the plugin name. */
  logger: Logger;
  /** Site configuration (read-only). */
  config: Readonly<Record<string, unknown>>;
  /**
   * Background jobs: `jobs.registerJob()` adds a handler (removed on deactivation) and
   * `jobs.enqueue()` queues work. Only present when the site runs a job queue.
   */
  jobs?: ScopedJobs;
  /**
   * Admin extension points: sidebar menu items, pages made of settings panels and custom post
   * fields. Everything added here is removed on deactivation.
   */
  admin: ScopedAdmin;
  /**
   * Add a widget type that site owners can place in a theme's widget areas. Removed when the
   * plugin is deactivated.
   */
  registerWidget(definition: WidgetTypeDefinition): void;
  /**
   * HTTP routes under `/api/v1/plugins/<your plugin name>/`, each with the capability a caller
   * needs (or `'public'`). Removed when the plugin is deactivated; a handler that throws answers
   * `500` and nothing else is affected.
   */
  routes: ScopedPluginRoutes;
  /**
   * Parameterized queries on your own tables (names starting with your plugin name and `_`).
   * Only present when `plugin.json` declares the `database` permission and the site has a
   * database to give. See `plugin-db.ts` for what is allowed.
   */
  db?: PluginDatabase;
}

export interface PluginDefinition {
  /** Unique, kebab-case plugin name, e.g. "reading-time". */
  name: string;
  version?: string;
  description?: string;
  /** Called on activation. Register hooks, content types, routes, etc. here. */
  setup(context: PluginContext): void | Promise<void>;
  /** Called on deactivation, after the plugin's hooks are removed. */
  teardown?(context: PluginContext): void | Promise<void>;
}

/** Identity helper that gives plugin authors full type inference. */
export function definePlugin<T extends PluginDefinition>(plugin: T): T {
  return plugin;
}

export type PluginStatus = 'registered' | 'active' | 'inactive' | 'failed';

export interface PluginInfo {
  name: string;
  version: string | undefined;
  description: string | undefined;
  status: PluginStatus;
  error: string | undefined;
  /** The HTTP routes the plugin added (for the permission review). */
  routes?: Array<{ method: string; path: string; capability: string }>;
}

interface PluginRecord {
  definition: PluginDefinition;
  status: PluginStatus;
  error: string | undefined;
  context: PluginContext | undefined;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set(['core']);

export class PluginManager {
  #plugins = new Map<string, PluginRecord>();
  #hooks: HookRegistry;
  #logger: Logger;
  #config: Readonly<Record<string, unknown>>;
  #jobs: JobQueue | undefined;
  #admin: AdminExtensions;
  #routes = new PluginRouteRegistry();
  #runner: ParameterizedSqlRunner | undefined;
  /** Permissions declared in `plugin.json`, for plugins that came from a package. */
  #permissions = new Map<string, readonly string[]>();

  constructor(hooks: HookRegistry, logger: Logger, config: Readonly<Record<string, unknown>>) {
    this.#hooks = hooks;
    this.#logger = logger;
    this.#config = config;
    this.#admin = new AdminExtensions({ hooks });
  }

  /** What plugins added to the admin; the server reads it to build the admin's menu and pages. */
  get admin(): AdminExtensions {
    return this.#admin;
  }

  /** The HTTP routes plugins added; the server mounts them under `/api/v1/plugins/<name>/`. */
  get routes(): PluginRouteRegistry {
    return this.#routes;
  }

  /** Give plugins that declare the `database` permission a way to run queries (`context.db`). */
  useDatabase(runner: ParameterizedSqlRunner): void {
    this.#runner = runner;
  }

  /** Give plugins activated from now on a job queue (`context.jobs`). */
  useJobs(queue: JobQueue): void {
    this.#jobs = queue;
  }

  /**
   * Add a plugin. `options.permissions` are the ones its `plugin.json` declares; without them a
   * plugin gets no `context.db` (built-in plugins do not need one).
   */
  register(definition: PluginDefinition, options: { permissions?: readonly string[] } = {}): void {
    if (!definition || typeof definition.setup !== 'function') {
      throw new TypeError('A plugin must be an object with a setup() function');
    }
    const { name } = definition;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name) || RESERVED.has(name)) {
      throw new TypeError(
        `Invalid plugin name "${String(name)}" (use kebab-case, e.g. "my-plugin")`,
      );
    }
    if (this.#plugins.has(name)) {
      throw new Error(`Plugin "${name}" is already registered`);
    }
    if (options.permissions) this.#permissions.set(name, options.permissions);
    this.#plugins.set(name, {
      definition,
      status: 'registered',
      error: undefined,
      context: undefined,
    });
  }

  /**
   * Activate a registered plugin. If its setup() throws, any hooks it added are removed,
   * it is marked "failed", and the site keeps running. Returns true on success.
   */
  async activate(name: string): Promise<boolean> {
    const record = this.#get(name);
    if (record.status === 'active') return true;

    const context: PluginContext = {
      hooks: scopeHooks(this.#hooks, name),
      logger: this.#logger.child(name),
      config: this.#config,
      admin: this.#admin.scoped(name),
      registerWidget: (definition) => {
        scopeHooks(this.#hooks, name).addFilter('widget:types', (types) => [...types, definition]);
      },
      routes: { add: (definition) => this.#routes.add(name, definition) },
      ...(this.#runner && this.#permissions.get(name)?.includes('database')
        ? { db: createPluginDatabase(name, this.#runner) }
        : {}),
      ...(this.#jobs ? { jobs: this.#jobs.scoped(name) } : {}),
    };

    try {
      await record.definition.setup(context);
    } catch (error) {
      this.#hooks.removeAllFromSource(name);
      this.#jobs?.removeAllFromSource(name);
      this.#admin.removeAllFromSource(name);
      this.#routes.removeAllFromSource(name);
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.context = undefined;
      this.#logger.error(`Plugin "${name}" failed to activate`, { error: record.error });
      await this.#hooks.doAction('plugin:error', { name, error });
      return false;
    }

    record.status = 'active';
    record.error = undefined;
    record.context = context;
    this.#logger.info(`Plugin "${name}" activated`);
    await this.#hooks.doAction('plugin:activated', { name });
    return true;
  }

  async deactivate(name: string): Promise<void> {
    const record = this.#get(name);
    if (record.status !== 'active' || !record.context) return;

    this.#hooks.removeAllFromSource(name);
    this.#jobs?.removeAllFromSource(name);
    this.#admin.removeAllFromSource(name);
    this.#routes.removeAllFromSource(name);
    try {
      await record.definition.teardown?.(record.context);
    } catch (error) {
      this.#logger.error(`Plugin "${name}" threw during teardown`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    record.status = 'inactive';
    record.context = undefined;
    this.#logger.info(`Plugin "${name}" deactivated`);
    await this.#hooks.doAction('plugin:deactivated', { name });
  }

  async activateAll(): Promise<void> {
    for (const name of this.#plugins.keys()) await this.activate(name);
  }

  async deactivateAll(): Promise<void> {
    // Reverse order, so plugins that depend on earlier ones shut down first.
    for (const name of [...this.#plugins.keys()].reverse()) await this.deactivate(name);
  }

  isActive(name: string): boolean {
    return this.#plugins.get(name)?.status === 'active';
  }

  list(): PluginInfo[] {
    return [...this.#plugins.values()].map((r) => ({
      name: r.definition.name,
      version: r.definition.version,
      description: r.definition.description,
      status: r.status,
      error: r.error,
      routes: this.#routes
        .list(r.definition.name)
        .map(({ method, path, capability }) => ({ method, path, capability })),
    }));
  }

  #get(name: string): PluginRecord {
    const record = this.#plugins.get(name);
    if (!record) throw new Error(`Plugin "${name}" is not registered`);
    return record;
  }
}
