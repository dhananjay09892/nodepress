import { describe, expect, it, vi } from 'vitest';
import { createNodePress } from './kernel.js';
import { silentLogger } from './logger.js';
import { definePlugin } from './plugins.js';

const quiet = { logger: silentLogger };

describe('kernel lifecycle', () => {
  it('boots, activates plugins in order and fires lifecycle hooks', async () => {
    const events: string[] = [];
    const np = createNodePress({
      ...quiet,
      plugins: [
        definePlugin({
          name: 'first',
          setup({ hooks }) {
            events.push('setup:first');
            hooks.addAction('core:ready', () => void events.push('ready:first'));
          },
        }),
        definePlugin({ name: 'second', setup: () => void events.push('setup:second') }),
      ],
    });
    np.hooks.addAction('core:boot', () => void events.push('boot'));

    expect(np.state).toBe('created');
    await np.boot();
    expect(np.state).toBe('ready');
    expect(events).toEqual(['boot', 'setup:first', 'setup:second', 'ready:first']);
  });

  it('refuses to boot twice', async () => {
    const np = createNodePress(quiet);
    await np.boot();
    await expect(np.boot()).rejects.toThrow(/Cannot boot/);
  });

  it('shuts down: fires core:shutdown, then deactivates plugins in reverse', async () => {
    const events: string[] = [];
    const np = createNodePress({
      ...quiet,
      plugins: ['a', 'b'].map((name) =>
        definePlugin({
          name,
          setup: ({ hooks }) => {
            hooks.addAction('core:shutdown', () => void events.push(`shutdown-hook:${name}`));
          },
          teardown: () => void events.push(`teardown:${name}`),
        }),
      ),
    });
    await np.boot();
    await np.shutdown();
    expect(np.state).toBe('stopped');
    expect(events).toEqual(['shutdown-hook:a', 'shutdown-hook:b', 'teardown:b', 'teardown:a']);
  });

  it('freezes config passed to plugins', async () => {
    let seen: Readonly<Record<string, unknown>> | undefined;
    const np = createNodePress({
      ...quiet,
      config: { siteName: 'My Site' },
      plugins: [definePlugin({ name: 'reader', setup: ({ config }) => void (seen = config) })],
    });
    await np.boot();
    expect(seen?.siteName).toBe('My Site');
    expect(Object.isFrozen(seen)).toBe(true);
  });
});

describe('plugins', () => {
  it('a plugin can filter content', async () => {
    const np = createNodePress({
      ...quiet,
      plugins: [
        definePlugin({
          name: 'reading-time',
          setup({ hooks }) {
            hooks.addFilter('post:content', (html) => `<p>1 min read</p>${html as string}`);
          },
        }),
      ],
    });
    await np.boot();
    expect(await np.hooks.applyFilters('post:content', '<p>Hi</p>')).toBe(
      '<p>1 min read</p><p>Hi</p>',
    );
  });

  it('a failing plugin is marked failed, its hooks are removed, and the site still boots', async () => {
    const onPluginError = vi.fn();
    const np = createNodePress({
      ...quiet,
      plugins: [
        definePlugin({
          name: 'broken',
          setup({ hooks }) {
            hooks.addFilter('title', () => 'hijacked');
            throw new Error('missing API key');
          },
        }),
        definePlugin({ name: 'fine', setup: () => {} }),
      ],
    });
    np.hooks.addAction('plugin:error', onPluginError);
    await np.boot();

    expect(np.state).toBe('ready');
    expect(np.plugins.list()).toEqual([
      expect.objectContaining({ name: 'broken', status: 'failed', error: 'missing API key' }),
      expect.objectContaining({ name: 'fine', status: 'active' }),
    ]);
    expect(await np.hooks.applyFilters('title', 'Original')).toBe('Original');
    expect(onPluginError).toHaveBeenCalledWith(expect.objectContaining({ name: 'broken' }));
  });

  it('deactivating a plugin removes its hooks; reactivating restores them', async () => {
    const np = createNodePress({
      ...quiet,
      plugins: [
        definePlugin({
          name: 'shout',
          setup: ({ hooks }) => void hooks.addFilter('title', (t) => (t as string).toUpperCase()),
        }),
      ],
    });
    await np.boot();
    expect(await np.hooks.applyFilters('title', 'hi')).toBe('HI');

    await np.plugins.deactivate('shout');
    expect(np.plugins.isActive('shout')).toBe(false);
    expect(await np.hooks.applyFilters('title', 'hi')).toBe('hi');

    await np.plugins.activate('shout');
    expect(await np.hooks.applyFilters('title', 'hi')).toBe('HI');
  });

  it('rejects invalid and duplicate plugins', () => {
    const np = createNodePress(quiet);
    expect(() => np.plugins.register({ name: 'Bad Name', setup() {} })).toThrow(/Invalid plugin name/);
    expect(() => np.plugins.register({ name: 'core', setup() {} })).toThrow(/Invalid plugin name/);
    expect(() => np.plugins.register({ name: 'x' } as never)).toThrow(/setup/);
    np.plugins.register({ name: 'dup', setup() {} });
    expect(() => np.plugins.register({ name: 'dup', setup() {} })).toThrow(/already registered/);
  });

  it('throws when activating an unknown plugin', async () => {
    const np = createNodePress(quiet);
    await expect(np.plugins.activate('ghost')).rejects.toThrow(/not registered/);
  });
});
