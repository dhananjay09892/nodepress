/**
 * @nodepress/sdk — the public API for NodePress plugin and theme authors.
 *
 * ```ts
 * import { definePlugin } from '@nodepress/sdk';
 *
 * export default definePlugin({
 *   name: 'hello',
 *   setup({ hooks, logger }) {
 *     hooks.addAction('core:ready', () => logger.info('Hello from my plugin!'));
 *   },
 * });
 * ```
 */
export {
  definePlugin,
  type PluginDefinition,
  type PluginContext,
  type ScopedHooks,
  type ActionMap,
  type FilterMap,
  type ListenerOptions,
  type Unsubscribe,
  type Logger,
} from '@nodepress/core';
export type {
  ContentTypeDefinition,
  FieldDefinition,
  TextField,
  RichTextField,
  NumberField,
  BooleanField,
  DateField,
  SelectField,
  MediaField,
  RelationField,
} from '@nodepress/core';
