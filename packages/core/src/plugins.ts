import { scopeHooks, type HookRegistry, type ScopedHooks } from './hooks.js';
import type { Logger } from './logger.js';

export interface PluginContext {
  /** Hooks scoped to this plugin: everything added here is removed on deactivation. */
  hooks: ScopedHooks;
  /** Logger prefixed with the plugin name. */
  logger: Logger;
  /** Site configuration (read-only). */
  config: Readonly<Record<string, unknown>>;
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

  constructor(hooks: HookRegistry, logger: Logger, config: Readonly<Record<string, unknown>>) {
    this.#hooks = hooks;
    this.#logger = logger;
    this.#config = config;
  }

  register(definition: PluginDefinition): void {
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
    };

    try {
      await record.definition.setup(context);
    } catch (error) {
      this.#hooks.removeAllFromSource(name);
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
    }));
  }

  #get(name: string): PluginRecord {
    const record = this.#plugins.get(name);
    if (!record) throw new Error(`Plugin "${name}" is not registered`);
    return record;
  }
}
