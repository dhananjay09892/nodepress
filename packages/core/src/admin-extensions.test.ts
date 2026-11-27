import { describe, expect, it } from 'vitest';
import { PanelValidationError } from './admin-extensions.js';
import { createContentTypeRegistry } from './content-types.js';
import { createNodePress } from './kernel.js';
import { silentLogger } from './logger.js';
import { createOptionsService, type OptionRow, type OptionsStore } from './options.js';
import { definePlugin, type PluginDefinition } from './plugins.js';

function memoryStore(): OptionsStore & { rows: Map<string, OptionRow> } {
  const rows = new Map<string, OptionRow>();
  return {
    rows,
    getAutoloaded: async () => [...rows.values()].filter((r) => r.autoload),
    get: async (key) => rows.get(key),
    upsert: async (row) => void rows.set(row.key, { ...row }),
    delete: async (key) => rows.delete(key),
  };
}

const settingsPage = {
  id: 'general',
  title: 'Analytics settings',
  panels: [
    {
      id: 'tracking',
      title: 'Tracking',
      fields: [
        { name: 'site_id', type: 'text' as const, label: 'Site ID', maxLength: 20 },
        { name: 'sample_rate', type: 'number' as const, min: 0, max: 100, default: 100 },
        { name: 'enabled', type: 'boolean' as const, default: true },
        { name: 'region', type: 'select' as const, options: ['eu', 'us'], default: 'eu' },
      ],
    },
  ],
};

async function boot(...plugins: PluginDefinition[]) {
  const np = createNodePress({ logger: silentLogger, plugins });
  await np.boot();
  const options = createOptionsService({ store: memoryStore(), hooks: np.hooks });
  np.admin.useOptions(options);
  return { np, options };
}

const allow =
  (...caps: string[]) =>
  async (c: string) =>
    caps.includes(c);

describe('admin pages and menu items', () => {
  const plugin = definePlugin({
    name: 'stats',
    setup({ admin }) {
      admin.addPage(settingsPage);
      admin.addMenuItem({ id: 'stats-menu', label: 'Stats', page: 'general', order: 20 });
    },
  });

  it('lists pages and menu items for people allowed to open them', async () => {
    const { np } = await boot(plugin);
    const view = await np.admin.describe(allow('manage_options'));
    expect(view.menu).toEqual([
      { plugin: 'stats', id: 'stats-menu', label: 'Stats', page: 'general' },
    ]);
    expect(view.pages.map((p) => [p.plugin, p.id, p.title])).toEqual([
      ['stats', 'general', 'Analytics settings'],
    ]);
  });

  it('hides a page and its menu item from people without the capability', async () => {
    const { np } = await boot(plugin);
    expect(await np.admin.describe(allow('edit_posts'))).toEqual({ menu: [], pages: [] });
  });

  it('lets a plugin choose the capability a page needs', async () => {
    const { np } = await boot(
      definePlugin({
        name: 'editorial',
        setup({ admin }) {
          admin.addPage({ ...settingsPage, capability: 'edit_others_posts' });
          admin.addMenuItem({ id: 'menu', label: 'Editorial', page: 'general' });
        },
      }),
    );
    expect((await np.admin.describe(allow('edit_others_posts'))).menu).toHaveLength(1);
    expect((await np.admin.describe(allow('manage_options'))).menu).toHaveLength(0);
  });

  it('orders menu items by order, then label, across plugins', async () => {
    const make = (name: string, label: string, order?: number) =>
      definePlugin({
        name,
        setup({ admin }) {
          admin.addPage(settingsPage);
          admin.addMenuItem({ id: 'm', label, page: 'general', ...(order ? { order } : {}) });
        },
      });
    const { np } = await boot(make('p-b', 'Beta'), make('p-a', 'Alpha'), make('p-c', 'First', 5));
    const view = await np.admin.describe(allow('manage_options'));
    expect(view.menu.map((m) => m.label)).toEqual(['First', 'Alpha', 'Beta']);
  });

  it('hides a menu item whose page does not exist', async () => {
    const { np } = await boot(
      definePlugin({
        name: 'dangling',
        setup({ admin }) {
          admin.addMenuItem({ id: 'm', label: 'Nowhere', page: 'missing' });
        },
      }),
    );
    expect((await np.admin.describe(allow('manage_options'))).menu).toEqual([]);
  });

  it('removes everything when the plugin is deactivated', async () => {
    const { np } = await boot(plugin);
    await np.plugins.deactivate('stats');
    expect(await np.admin.describe(allow('manage_options'))).toEqual({ menu: [], pages: [] });
  });

  it('fails the plugin, not the site, on an invalid page, and keeps nothing it added', async () => {
    const bad = definePlugin({
      name: 'broken',
      setup({ admin }) {
        admin.addPage(settingsPage);
        admin.addPage({ ...settingsPage, id: 'Bad Id' });
      },
    });
    const { np } = await boot(bad, plugin);
    expect(np.plugins.list().find((p) => p.name === 'broken')?.status).toBe('failed');
    expect(np.plugins.list().find((p) => p.name === 'stats')?.status).toBe('active');
    const view = await np.admin.describe(allow('manage_options'));
    expect(view.pages.map((p) => p.plugin)).toEqual(['stats']);
  });

  it.each([
    ['a duplicate page id', () => [settingsPage, settingsPage]],
    ['a page without panels', () => [{ ...settingsPage, id: 'empty', panels: [] }]],
    [
      'a rich text field',
      () => [
        {
          ...settingsPage,
          panels: [{ id: 'p', title: 'P', fields: [{ name: 'body', type: 'richtext' }] }],
        },
      ],
    ],
    [
      'two fields with the same name',
      () => [
        {
          ...settingsPage,
          panels: [
            {
              id: 'p',
              title: 'P',
              fields: [
                { name: 'a', type: 'text' },
                { name: 'a', type: 'boolean' },
              ],
            },
          ],
        },
      ],
    ],
    ['an empty title', () => [{ ...settingsPage, title: ' ' }]],
  ])('rejects %s', async (_label, pages) => {
    const { np } = await boot(
      definePlugin({
        name: 'strict',
        setup({ admin }) {
          for (const page of pages()) admin.addPage(page as never);
        },
      }),
    );
    expect(np.plugins.list()[0]?.status).toBe('failed');
  });

  it('rejects a duplicate menu item id', async () => {
    const { np } = await boot(
      definePlugin({
        name: 'dupes',
        setup({ admin }) {
          admin.addPage(settingsPage);
          admin.addMenuItem({ id: 'm', label: 'One', page: 'general' });
          admin.addMenuItem({ id: 'm', label: 'Two', page: 'general' });
        },
      }),
    );
    expect(np.plugins.list()[0]?.status).toBe('failed');
  });
});

describe('settings panels', () => {
  const plugin = definePlugin({
    name: 'stats',
    setup({ admin }) {
      admin.addPage(settingsPage);
    },
  });

  it('returns defaults until something is saved', async () => {
    const { np } = await boot(plugin);
    expect(await np.admin.readPanel('stats', 'general', 'tracking')).toEqual({
      sample_rate: 100,
      enabled: true,
      region: 'eu',
    });
  });

  it('saves only the fields sent and stores them without autoload', async () => {
    const { np, options } = await boot(plugin);
    const saved = await np.admin.writePanel('stats', 'general', 'tracking', {
      site_id: 'abc',
      sample_rate: 25,
    });
    expect(saved).toEqual({ site_id: 'abc', sample_rate: 25, enabled: true, region: 'eu' });
    await np.admin.writePanel('stats', 'general', 'tracking', { enabled: false });
    expect(await options.get('admin-ext:stats:general:tracking')).toEqual({
      site_id: 'abc',
      sample_rate: 25,
      enabled: false,
    });
  });

  it('clears a field back to its default with null', async () => {
    const { np } = await boot(plugin);
    await np.admin.writePanel('stats', 'general', 'tracking', { sample_rate: 5 });
    const saved = await np.admin.writePanel('stats', 'general', 'tracking', { sample_rate: null });
    expect(saved['sample_rate']).toBe(100);
  });

  it.each([
    ['an out-of-range number', { sample_rate: 101 }, 'sample_rate'],
    ['text that is too long', { site_id: 'x'.repeat(21) }, 'site_id'],
    ['an unknown select option', { region: 'asia' }, 'region'],
    ['a wrong type', { enabled: 'yes' }, 'enabled'],
    ['an unknown field', { nope: 1 }, ''],
  ])('rejects %s and saves nothing', async (_label, input, path) => {
    const { np, options } = await boot(plugin);
    const error = await np.admin
      .writePanel('stats', 'general', 'tracking', { site_id: 'ok', ...input })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PanelValidationError);
    expect((error as PanelValidationError).issues.map((i) => i.path)).toContain(path);
    expect(await options.get('admin-ext:stats:general:tracking')).toBeUndefined();
  });

  it('throws for an unknown plugin, page or panel', async () => {
    const { np } = await boot(plugin);
    await expect(np.admin.readPanel('nope', 'general', 'tracking')).rejects.toThrow(/Unknown/);
    await expect(np.admin.writePanel('stats', 'general', 'nope', {})).rejects.toThrow(/Unknown/);
  });

  it('lets the plugin read its own settings through context.admin', async () => {
    let read: Record<string, unknown> | undefined;
    const { np } = await boot(
      definePlugin({
        name: 'stats',
        setup({ admin, hooks }) {
          admin.addPage(settingsPage);
          hooks.addAction('core:ready', async () => {
            read = await admin.getSettings('general', 'tracking');
          });
        },
      }),
    );
    await np.admin.writePanel('stats', 'general', 'tracking', { site_id: 'zzz' });
    await np.hooks.doAction('core:ready');
    expect(read?.['site_id']).toBe('zzz');
  });
});

describe('custom post fields', () => {
  const subtitle = { name: 'subtitle', type: 'text' as const, label: 'Subtitle', maxLength: 80 };

  it('adds a field to post and page by default, and validates it', async () => {
    const { np } = await boot(
      definePlugin({
        name: 'subtitles',
        setup({ admin }) {
          admin.addPostField({ field: subtitle });
        },
      }),
    );
    const types = createContentTypeRegistry({ hooks: np.hooks, logger: silentLogger });
    await types.refresh();
    expect(types.get('post')?.fields.map((f) => f.name)).toEqual(['featured_image', 'subtitle']);
    expect(types.get('page')?.fields.map((f) => f.name)).toContain('subtitle');
    expect(types.validate('post', { subtitle: 'Hello' }).ok).toBe(true);
    expect(types.validate('post', { subtitle: 'x'.repeat(81) }).ok).toBe(false);
  });

  it('can target other content types', async () => {
    const { np } = await boot(
      definePlugin({
        name: 'targets',
        setup({ admin, hooks }) {
          admin.addPostField({ contentTypes: ['product'], field: subtitle });
          hooks.addFilter('content-type:definitions', (defs) => [
            ...defs,
            { name: 'product', fields: [] },
          ]);
        },
      }),
    );
    const types = createContentTypeRegistry({ hooks: np.hooks, logger: silentLogger });
    await types.refresh();
    expect(types.get('product')?.fields.map((f) => f.name)).toEqual(['subtitle']);
    expect(types.get('post')?.fields.map((f) => f.name)).toEqual(['featured_image']);
  });

  it('skips a field that clashes with an existing one, keeping the rest', async () => {
    const { np } = await boot(
      definePlugin({
        name: 'clash',
        setup({ admin }) {
          admin.addPostField({ field: { name: 'featured_image', type: 'text' } });
          admin.addPostField({ field: subtitle });
        },
      }),
    );
    const types = createContentTypeRegistry({ hooks: np.hooks, logger: silentLogger });
    await types.refresh();
    const fields = types.get('post')!.fields;
    expect(fields.find((f) => f.name === 'featured_image')?.type).toBe('media');
    expect(fields.map((f) => f.name)).toContain('subtitle');
  });

  it('removes the field after deactivation and a refresh', async () => {
    const { np } = await boot(
      definePlugin({
        name: 'subtitles',
        setup({ admin }) {
          admin.addPostField({ field: subtitle });
        },
      }),
    );
    const types = createContentTypeRegistry({ hooks: np.hooks, logger: silentLogger });
    await types.refresh();
    await np.plugins.deactivate('subtitles');
    await types.refresh();
    expect(types.get('post')?.fields.map((f) => f.name)).toEqual(['featured_image']);
  });

  it('fails the plugin on an invalid field definition', async () => {
    const { np } = await boot(
      definePlugin({
        name: 'bad-field',
        setup({ admin }) {
          admin.addPostField({ field: { name: 'Bad Name', type: 'text' } });
        },
      }),
    );
    expect(np.plugins.list()[0]?.status).toBe('failed');
  });
});

describe('report pages', () => {
  const report = {
    route: '/summary',
    defaultDays: 14,
    totals: [{ key: 'views', label: 'Page views' }],
    chart: {
      title: 'Per day',
      rows: 'days',
      x: 'day',
      series: [{ key: 'views', label: 'Views' }],
    },
    tables: [
      {
        rows: 'pages',
        title: 'Top pages',
        columns: [
          { key: 'path', label: 'Page' },
          { key: 'views', label: 'Views', numeric: true },
        ],
      },
    ],
  };
  const reportPage = { id: 'overview', title: 'Overview', panels: [], report };

  const plugin = definePlugin({
    name: 'stats',
    setup({ admin }) {
      admin.addPage(reportPage);
      admin.addMenuItem({ id: 'overview', label: 'Overview', page: 'overview' });
    },
  });

  it('lists a report-only page with its report and no panels', async () => {
    const { np } = await boot(plugin);
    const view = await np.admin.describe(allow('manage_options'));
    expect(view.pages).toHaveLength(1);
    expect(view.pages[0]?.panels).toEqual([]);
    expect(view.pages[0]?.report).toEqual({ ...report, maxDays: 366 });
    expect(view.menu.map((m) => m.page)).toEqual(['overview']);
  });

  it('applies the page capability to a report like to any page', async () => {
    const { np } = await boot(plugin);
    expect(await np.admin.describe(allow('edit_posts'))).toEqual({ menu: [], pages: [] });
  });

  it('does not let the plugin change a report after adding it', async () => {
    const mutable = structuredClone(report);
    const { np } = await boot(
      definePlugin({
        name: 'stats',
        setup({ admin }) {
          admin.addPage({ ...reportPage, report: mutable });
          mutable.route = '/other';
          mutable.totals[0]!.label = 'Changed';
        },
      }),
    );
    const view = await np.admin.describe(allow('manage_options'));
    expect(view.pages[0]?.report?.route).toBe('/summary');
    expect(view.pages[0]?.report?.totals?.[0]?.label).toBe('Page views');
  });

  it.each([
    ['a route with a query', { ...report, route: '/summary?x=1' }],
    ['a route that climbs out', { ...report, route: '/a/../b' }],
    ['a route without a slash', { ...report, route: 'summary' }],
    ['an absolute URL', { ...report, route: 'https://evil.example/x' }],
    ['a report with nothing to show', { route: '/summary' }],
    ['a bad key', { ...report, totals: [{ key: 'a b', label: 'A' }] }],
    ['no chart series', { ...report, chart: { ...report.chart, series: [] } }],
    ['no table columns', { ...report, tables: [{ ...report.tables[0], columns: [] }] }],
    ['a default range longer than the maximum', { ...report, defaultDays: 90, maxDays: 30 }],
    ['a fractional range', { ...report, defaultDays: 1.5 }],
  ])('rejects %s', async (_label, bad) => {
    const { np } = await boot(
      definePlugin({
        name: 'strict',
        setup({ admin }) {
          admin.addPage({ ...reportPage, report: bad as never });
        },
      }),
    );
    expect(np.plugins.list()[0]?.status).toBe('failed');
  });

  it('still needs a panel when the page has no report', async () => {
    const { np } = await boot(
      definePlugin({
        name: 'strict',
        setup({ admin }) {
          admin.addPage({ id: 'empty', title: 'Empty', panels: [] });
        },
      }),
    );
    expect(np.plugins.list()[0]?.status).toBe('failed');
  });
});
