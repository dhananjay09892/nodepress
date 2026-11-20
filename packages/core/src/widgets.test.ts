import { describe, expect, it } from 'vitest';
import { HookRegistry, scopeHooks } from './hooks.js';
import { createNodePress } from './kernel.js';
import { silentLogger, type Logger } from './logger.js';
import { definePlugin } from './plugins.js';
import { createOptionsService, type OptionRow, type OptionsStore } from './options.js';
import {
  MAX_WIDGETS_PER_AREA,
  WidgetValidationError,
  createWidgetService,
  type WidgetTypeDefinition,
} from './widgets.js';

function setup(extra: Partial<Parameters<typeof createWidgetService>[0]> = {}) {
  const rows = new Map<string, OptionRow>();
  const store: OptionsStore = {
    getAutoloaded: async () => [...rows.values()].map((r) => ({ ...r })),
    get: async (key) => rows.get(key),
    upsert: async (row) => void rows.set(row.key, { ...row }),
    delete: async (key) => rows.delete(key),
  };
  const hooks = new HookRegistry();
  const options = createOptionsService({ store, hooks });
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (message) => void warnings.push(message),
    error() {},
    child: () => logger,
  };
  const widgets = createWidgetService({ options, hooks, logger, ...extra });
  return { widgets, hooks, options, warnings };
}

const AREAS = ['sidebar', 'footer'];

const clock: WidgetTypeDefinition = {
  type: 'demo/clock',
  title: 'Clock',
  fields: [],
  parse: () => ({}),
  render: () => '<p>12:00</p>',
};

describe('built-in types', () => {
  it('lists text, menu and recent-posts with their fields', () => {
    const { widgets } = setup();
    const types = widgets.types();
    expect(types.map((t) => t.type)).toEqual(['text', 'menu', 'recent-posts']);
    expect(types[0]!.fields.map((f) => f.name)).toEqual(['title', 'text']);
  });

  it('renders text as escaped paragraphs and keeps line breaks', async () => {
    const { widgets } = setup();
    await widgets.setAreas(
      {
        sidebar: [
          {
            type: 'text',
            settings: { title: ' About ', text: '<b>Hi</b> & bye\nline two\n\nSecond' },
          },
        ],
      },
      AREAS,
    );
    const { sidebar } = await widgets.forAreas(['sidebar']);
    expect(sidebar).toHaveLength(1);
    expect(sidebar![0]!.title).toBe('About');
    expect(sidebar![0]!.html).toBe(
      '<p>&lt;b&gt;Hi&lt;/b&gt; &amp; bye<br>line two</p><p>Second</p>',
    );
  });

  it('renders a menu widget as nested lists with escaped labels and no unsafe links', async () => {
    const menu = {
      id: 3,
      name: 'M',
      items: [
        {
          label: 'A <x>',
          url: '/a',
          children: [
            { label: 'Out', url: 'https://e.test', target: '_blank' as const, children: [] },
          ],
        },
        { label: 'Bad', url: 'javascript:alert(1)', children: [] },
      ],
    };
    const { widgets } = setup({ getMenu: async (id) => (id === 3 ? menu : undefined) });
    await widgets.setAreas({ sidebar: [{ type: 'menu', settings: { menuId: 3 } }] }, AREAS);
    const html = (await widgets.forAreas(['sidebar'])).sidebar![0]!.html;
    expect(html).toBe(
      '<ul><li><a href="/a">A &lt;x&gt;</a><ul><li><a href="https://e.test" target="_blank" rel="noopener noreferrer">Out</a></li></ul></li><li>Bad</li></ul>',
    );
  });

  it('renders recent posts with the count and escapes titles; a deleted menu renders nothing', async () => {
    let asked = 0;
    const { widgets } = setup({
      recentPosts: async (limit) => {
        asked = limit;
        return [{ title: 'One & <two>', url: '/blog/one' }];
      },
    });
    await widgets.setAreas(
      {
        sidebar: [
          { type: 'recent-posts', settings: { count: 3 } },
          { type: 'recent-posts', settings: {} },
          { type: 'menu', settings: { menuId: 99 } },
        ],
      },
      AREAS,
    );
    const { sidebar } = await widgets.forAreas(['sidebar']);
    expect(asked).toBe(5); // the last recent-posts widget used the default
    expect(sidebar![0]!.html).toBe(
      '<ul><li><a href="/blog/one">One &amp; &lt;two&gt;</a></li></ul>',
    );
    expect(sidebar![2]!.html).toBe('');
  });
});

describe('setAreas', () => {
  it('gives ids, keeps unmentioned areas and returns every known area', async () => {
    const { widgets } = setup();
    await widgets.setAreas({ footer: [{ type: 'text', settings: { text: 'Foot' } }] }, AREAS);
    const result = await widgets.setAreas(
      { sidebar: [{ id: 'mine', type: 'text', settings: { text: 'Side' } }] },
      AREAS,
    );
    expect(result['sidebar']![0]!.id).toBe('mine');
    expect(result['footer']![0]!.id).toMatch(/^w_[0-9a-f]{12}$/);
    expect(result['footer']![0]!.settings).toEqual({ text: 'Foot' });
  });

  it('keeps the order it was given and can clear an area', async () => {
    const { widgets } = setup();
    await widgets.setAreas(
      {
        sidebar: [
          { id: 'b', type: 'text', settings: { text: 'B' } },
          { id: 'a', type: 'text', settings: { text: 'A' } },
        ],
      },
      AREAS,
    );
    expect((await widgets.getAreas(['sidebar']))['sidebar']!.map((w) => w.id)).toEqual(['b', 'a']);
    await widgets.setAreas({ sidebar: [] }, AREAS);
    expect((await widgets.getAreas(['sidebar']))['sidebar']).toEqual([]);
  });

  it.each([
    ['an unknown area', { nope: [] }, 'nope'],
    ['a non-list area', { sidebar: 'x' }, 'sidebar'],
    ['a non-object widget', { sidebar: [1] }, 'sidebar[0]'],
    ['an unknown type', { sidebar: [{ type: 'zzz' }] }, 'sidebar[0].type'],
    ['missing text', { sidebar: [{ type: 'text', settings: {} }] }, 'sidebar[0].settings'],
    [
      'a bad count',
      { sidebar: [{ type: 'recent-posts', settings: { count: 99 } }] },
      'sidebar[0].settings',
    ],
    [
      'a bad menu id',
      { sidebar: [{ type: 'menu', settings: { menuId: 'x' } }] },
      'sidebar[0].settings',
    ],
    [
      'a bad id',
      { sidebar: [{ id: 'a b', type: 'text', settings: { text: 'x' } }] },
      'sidebar[0].id',
    ],
    [
      'a repeated id',
      {
        sidebar: [
          { id: 'x', type: 'text', settings: { text: 'x' } },
          { id: 'x', type: 'text', settings: { text: 'y' } },
        ],
      },
      'sidebar[1].id',
    ],
    ['non-object settings', { sidebar: [{ type: 'text', settings: 'x' }] }, 'sidebar[0].settings'],
  ])('refuses %s and saves nothing', async (_name, input, field) => {
    const { widgets } = setup();
    await widgets.setAreas({ footer: [{ type: 'text', settings: { text: 'kept' } }] }, AREAS);
    const error = await widgets.setAreas(input, AREAS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WidgetValidationError);
    expect((error as WidgetValidationError).field).toBe(field);
    expect((await widgets.getAreas(AREAS))['footer']).toHaveLength(1);
    expect((await widgets.getAreas(AREAS))['sidebar']).toEqual([]);
  });

  it('refuses too many widgets in an area', async () => {
    const { widgets } = setup();
    const many = Array.from({ length: MAX_WIDGETS_PER_AREA + 1 }, () => ({
      type: 'text',
      settings: { text: 'x' },
    }));
    await expect(widgets.setAreas({ sidebar: many }, AREAS)).rejects.toThrow(/at most/);
  });
});

describe('plugin widget types', () => {
  it('registerWidget adds a type that renders, and rejects bad or duplicate definitions', async () => {
    const { widgets } = setup();
    widgets.registerWidget(clock);
    expect(() => widgets.registerWidget(clock)).toThrow(/already exists/);
    expect(() => widgets.registerWidget({ ...clock, type: 'Bad Name' })).toThrow(/lowercase name/);
    expect(() => widgets.registerWidget({ ...clock, type: 'text' })).toThrow(/already exists/);
    await widgets.setAreas({ sidebar: [{ type: 'demo/clock' }] }, AREAS);
    expect((await widgets.forAreas(['sidebar'])).sidebar![0]!.html).toBe('<p>12:00</p>');
  });

  it('picks up the widget:types filter and drops a type when its plugin is deactivated', async () => {
    const { widgets, hooks } = setup();
    const scoped = scopeHooks(hooks, 'clock-plugin');
    scoped.addFilter('widget:types', (types) => [...types, clock]);
    await widgets.refresh();
    expect(widgets.types().map((t) => t.type)).toContain('demo/clock');
    await widgets.setAreas({ sidebar: [{ type: 'demo/clock' }] }, AREAS);

    hooks.removeAllFromSource('clock-plugin');
    await widgets.refresh();
    expect(widgets.types().map((t) => t.type)).not.toContain('demo/clock');
    // The saved widget stays saved but is not drawn.
    expect((await widgets.getAreas(['sidebar']))['sidebar']).toHaveLength(1);
    expect((await widgets.forAreas(['sidebar'])).sidebar).toEqual([]);
  });

  it('skips a malformed or clashing type from the filter and keeps the built-ins', async () => {
    const { widgets, hooks, warnings } = setup();
    hooks.addFilter('widget:types', (types) => [
      ...types,
      { type: 'text' } as unknown as WidgetTypeDefinition,
      clock,
    ]);
    await widgets.refresh();
    expect(widgets.types().map((t) => t.type)).toEqual([
      'text',
      'menu',
      'recent-posts',
      'demo/clock',
    ]);
    expect(warnings.some((w) => w.includes('skipped'))).toBe(true);
  });

  it('a widget whose render throws is left out and logged, the others still render', async () => {
    const { widgets, warnings } = setup();
    widgets.registerWidget({
      ...clock,
      type: 'demo/broken',
      render: () => {
        throw new Error('boom');
      },
    });
    await widgets.setAreas(
      {
        sidebar: [{ type: 'demo/broken' }, { type: 'text', settings: { text: 'still here' } }],
      },
      AREAS,
    );
    const { sidebar } = await widgets.forAreas(['sidebar']);
    expect(sidebar!.map((w) => w.type)).toEqual(['text']);
    expect(warnings.some((w) => w.includes('demo/broken'))).toBe(true);
  });
});

describe('context.registerWidget in a plugin', () => {
  it('adds the type while the plugin is active and removes it on deactivation', async () => {
    const np = createNodePress({
      logger: silentLogger,
      plugins: [
        definePlugin({
          name: 'clock-plugin',
          setup: ({ registerWidget }) => registerWidget(clock),
        }),
      ],
    });
    await np.boot();
    const rows = new Map<string, OptionRow>();
    const options = createOptionsService({
      store: {
        getAutoloaded: async () => [...rows.values()],
        get: async (key) => rows.get(key),
        upsert: async (row) => void rows.set(row.key, { ...row }),
        delete: async (key) => rows.delete(key),
      },
      hooks: np.hooks,
    });
    const widgets = createWidgetService({ options, hooks: np.hooks });
    await widgets.refresh();
    expect(widgets.types().map((t) => t.type)).toContain('demo/clock');
    await np.plugins.deactivate('clock-plugin');
    await widgets.refresh();
    expect(widgets.types().map((t) => t.type)).not.toContain('demo/clock');
  });
});
