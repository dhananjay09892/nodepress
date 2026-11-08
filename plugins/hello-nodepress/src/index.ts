import { definePlugin } from '@nodepress/sdk';

/**
 * The smallest useful NodePress plugin. Copy this folder to start your own.
 *
 * - Logs a greeting when the site is ready (an action).
 * - Adds a friendly line to the end of every post (a filter).
 */
export default definePlugin({
  name: 'hello-nodepress',
  version: '0.0.0',
  description: 'Example plugin showing actions and filters',
  setup({ hooks, logger }) {
    hooks.addAction('core:ready', () => {
      logger.info('Hello from hello-nodepress 👋');
    });

    hooks.addFilter('post:content', (html) => `${String(html)}\n<p>Thanks for reading!</p>`, {
      priority: 99,
    });
  },
});
