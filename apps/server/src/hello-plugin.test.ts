import {
  createNodePress,
  createOptionsService,
  silentLogger,
  type OptionRow,
  type OptionsStore,
} from '@nodepress/core';
import helloPlugin, { DEFAULT_CLOSING_LINE } from '@nodepress/plugin-hello';
import { describe, expect, it } from 'vitest';

function memoryStore(): OptionsStore {
  const rows = new Map<string, OptionRow>();
  return {
    getAutoloaded: async () => [...rows.values()].filter((r) => r.autoload),
    get: async (key) => rows.get(key),
    upsert: async (row) => void rows.set(row.key, { ...row }),
    delete: async (key) => rows.delete(key),
  };
}

async function boot() {
  const np = createNodePress({ logger: silentLogger, plugins: [helloPlugin] });
  await np.boot();
  np.admin.useOptions(createOptionsService({ store: memoryStore(), hooks: np.hooks }));
  return np;
}

const admin = async (capability: string) => capability === 'manage_options';

describe('the hello example plugin adds an admin settings page', () => {
  it('shows a Hello menu item and page to administrators only', async () => {
    const np = await boot();
    const view = await np.admin.describe(admin);
    expect(view.menu).toEqual([
      { plugin: 'hello-nodepress', id: 'hello', label: 'Hello', page: 'settings' },
    ]);
    expect(view.pages.map((p) => p.title)).toEqual(['Hello settings']);
    expect(await np.admin.describe(async () => false)).toEqual({ menu: [], pages: [] });
  });

  it('keeps the original closing line until it is changed', async () => {
    const np = await boot();
    expect(await np.hooks.applyFilters('post:content', '<p>Body</p>')).toBe(
      `<p>Body</p>\n<p>${DEFAULT_CLOSING_LINE}</p>`,
    );
  });

  it('uses the line saved on the settings page, escaped', async () => {
    const np = await boot();
    await np.admin.writePanel('hello-nodepress', 'settings', 'closing', {
      closing_line: 'See you <soon> & thanks',
    });
    expect(await np.hooks.applyFilters('post:content', '<p>Body</p>')).toBe(
      '<p>Body</p>\n<p>See you &lt;soon&gt; &amp; thanks</p>',
    );
  });

  it('adds nothing when the line is switched off', async () => {
    const np = await boot();
    await np.admin.writePanel('hello-nodepress', 'settings', 'closing', {
      show_closing_line: false,
    });
    expect(await np.hooks.applyFilters('post:content', '<p>Body</p>')).toBe('<p>Body</p>');
  });

  it('rejects a closing line that is too long', async () => {
    const np = await boot();
    await expect(
      np.admin.writePanel('hello-nodepress', 'settings', 'closing', {
        closing_line: 'x'.repeat(201),
      }),
    ).rejects.toThrow(/closing_line/);
  });
});
