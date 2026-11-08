import { HookRegistry } from './hooks.js';
import { createConsoleLogger, type Logger } from './logger.js';
import { PluginManager, type PluginDefinition } from './plugins.js';

declare module './hooks.js' {
  interface ActionMap {
    /** Core is starting; plugins are not yet active. */
    'core:boot': [];
    /** All plugins are active and the site is ready to serve requests. */
    'core:ready': [];
    /** The site is shutting down; plugins are still active. */
    'core:shutdown': [];
    'plugin:activated': [info: { name: string }];
    'plugin:deactivated': [info: { name: string }];
    'plugin:error': [info: { name: string; error: unknown }];
  }
}

export interface NodePressOptions {
  /** Plugins to register and activate on boot, in order. */
  plugins?: PluginDefinition[];
  /** Site configuration, exposed read-only to plugins. */
  config?: Record<string, unknown>;
  logger?: Logger;
}

export type KernelState = 'created' | 'booting' | 'ready' | 'stopping' | 'stopped';

export interface NodePress {
  readonly hooks: HookRegistry;
  readonly plugins: PluginManager;
  readonly logger: Logger;
  readonly config: Readonly<Record<string, unknown>>;
  readonly state: KernelState;
  /** Activate plugins and fire lifecycle hooks. Safe to call once. */
  boot(): Promise<void>;
  /** Fire shutdown hooks and deactivate plugins. */
  shutdown(): Promise<void>;
}

export function createNodePress(options: NodePressOptions = {}): NodePress {
  const logger = options.logger ?? createConsoleLogger('info', 'nodepress');
  const config = Object.freeze({ ...(options.config ?? {}) });
  const hooks = new HookRegistry({ logger: logger.child('hooks') });
  const plugins = new PluginManager(hooks, logger.child('plugins'), config);
  for (const plugin of options.plugins ?? []) plugins.register(plugin);

  let state: KernelState = 'created';

  return {
    hooks,
    plugins,
    logger,
    config,
    get state() {
      return state;
    },
    async boot() {
      if (state !== 'created') throw new Error(`Cannot boot from state "${state}"`);
      state = 'booting';
      await hooks.doAction('core:boot');
      await plugins.activateAll();
      state = 'ready';
      await hooks.doAction('core:ready');
      logger.info('NodePress is ready');
    },
    async shutdown() {
      if (state !== 'ready') return;
      state = 'stopping';
      await hooks.doAction('core:shutdown');
      await plugins.deactivateAll();
      state = 'stopped';
      logger.info('NodePress stopped');
    },
  };
}
