import { definePlugin } from '@nodepress/sdk';

/** The line added to the end of every post until someone changes it in the admin. */
export const DEFAULT_CLOSING_LINE = 'Thanks for reading!';

/**
 * The smallest useful NodePress plugin. Copy this folder to start your own.
 *
 * - Logs a greeting when the site is ready (an action).
 * - Adds a friendly line to the end of every post (a filter).
 * - Adds a "Hello" page to the admin where that line can be changed (an admin extension point:
 *   a page made of a settings panel, plus a sidebar menu item that opens it).
 */
export default definePlugin({
  name: 'hello-nodepress',
  version: '0.0.0',
  description: 'Example plugin showing actions, filters and an admin settings page',
  setup({ hooks, logger, admin }) {
    hooks.addAction('core:ready', () => {
      logger.info('Hello from hello-nodepress 👋');
    });

    // A page with one settings panel. The admin draws the form from this description and saves
    // the values for you; only administrators (`manage_options`) can open it unless you set
    // `capability`.
    admin.addPage({
      id: 'settings',
      title: 'Hello settings',
      description: 'Choose what the Hello plugin adds to your posts.',
      panels: [
        {
          id: 'closing',
          title: 'Closing',
          fields: [
            {
              name: 'closing_line',
              type: 'text',
              label: 'Closing line',
              description: 'Shown at the end of every post. Leave empty to use the default.',
              maxLength: 200,
              default: DEFAULT_CLOSING_LINE,
            },
            {
              name: 'show_closing_line',
              type: 'boolean',
              label: 'Show the closing line',
              default: true,
            },
          ],
        },
      ],
    });
    admin.addMenuItem({ id: 'hello', label: 'Hello', page: 'settings', order: 90 });

    hooks.addFilter(
      'post:content',
      async (html) => {
        let settings: Record<string, unknown> = {};
        try {
          settings = await admin.getSettings('settings', 'closing');
        } catch {
          // Settings are optional: without them the default line is used.
        }
        if (settings['show_closing_line'] === false) return html;
        const line = String(settings['closing_line'] ?? DEFAULT_CLOSING_LINE);
        return `${String(html)}\n<p>${escapeHtml(line)}</p>`;
      },
      { priority: 99 },
    );
  },
});

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}
