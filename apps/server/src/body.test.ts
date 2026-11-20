import {
  createContentService,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  createThemeService,
  discoverThemes,
  silentLogger,
  type Content,
} from '@nodepress/core';
import {
  createContentStore,
  createDatabase,
  createOptionsStore,
  createSlugRedirectsStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createBodyRenderer, toEditorBlock, toEditorBlocks } from './body.js';

describe('toEditorBlock', () => {
  it('converts stored text to text nodes and namespaces bare types', () => {
    expect(toEditorBlock({ type: 'paragraph', text: 'Hi' })).toEqual({
      type: 'core/paragraph',
      content: [{ text: 'Hi' }],
    });
  });

  it('keeps editor-shaped content, attrs and nested children', () => {
    const block = toEditorBlock({
      type: 'core/list',
      attrs: { ordered: true },
      children: [
        { type: 'core/list-item', content: [{ text: 'a', marks: [{ type: 'bold' }] }] },
        { type: 'core/list-item', text: 'b' },
        'junk',
      ],
    });
    expect(block).toEqual({
      type: 'core/list',
      attrs: { ordered: true },
      children: [
        { type: 'core/list-item', content: [{ text: 'a', marks: [{ type: 'bold' }] }] },
        { type: 'core/list-item', content: [{ text: 'b' }] },
      ],
    });
  });

  it('drops values that are not blocks and non-array bodies', () => {
    expect(toEditorBlock(null)).toBeUndefined();
    expect(toEditorBlock({ type: '' })).toBeUndefined();
    expect(toEditorBlock({ text: 'x' })).toBeUndefined();
    expect(toEditorBlocks('nope')).toEqual([]);
    expect(toEditorBlocks([1, { type: 'paragraph' }])).toEqual([{ type: 'core/paragraph' }]);
  });

  it('stops at a maximum depth', () => {
    let deep: Record<string, unknown> = { type: 'core/paragraph' };
    for (let i = 0; i < 20; i++) deep = { type: 'core/columns', children: [deep] };
    expect(JSON.stringify(toEditorBlock(deep))).not.toContain('core/paragraph');
  });
});

describe('createBodyRenderer', () => {
  it('renders blocks, escapes text, skips unknown blocks and applies post:content', async () => {
    const np = createNodePress({ logger: silentLogger });
    np.hooks.addFilter('post:content', (html) => `${String(html)}<!-- filtered -->`);
    const warnings: string[] = [];
    const render = createBodyRenderer({
      hooks: np.hooks,
      logger: { ...silentLogger, warn: (m: string) => void warnings.push(m) },
    });
    const html = await render({
      id: 7,
      body: [
        { type: 'core/heading', attrs: { level: 2 }, text: 'Title <b>' },
        { type: 'plugin/unknown', text: 'x' },
        { type: 'core/paragraph', text: 'Hello' },
      ],
    } as unknown as Content);
    expect(html).toBe('<h2>Title &lt;b&gt;</h2><p>Hello</p><!-- filtered -->');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('plugin/unknown');
  });
});

describe('post body at its permalink', () => {
  let root: string;
  let database: DatabaseHandle;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'np-body-'));
    await mkdir(join(root, 'demo', 'templates'), { recursive: true });
    await writeFile(join(root, 'demo', 'theme.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
    await writeFile(
      join(root, 'demo', 'templates', 'index.mjs'),
      `export default (p) => '<article>' + p.html + '</article>';`,
    );
    database = createDatabase({ url: ':memory:' });
    await database.migrate();
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  it('shows paragraph, heading and list blocks', async () => {
    const np = createNodePress({ logger: silentLogger });
    const store = createContentStore(database);
    const content = createContentService({ store, hooks: np.hooks });
    const permalinks = createPermalinkService({
      store,
      redirects: createSlugRedirectsStore(database),
      options: createOptionsService({ store: createOptionsStore(database), hooks: np.hooks }),
      hooks: np.hooks,
    });
    permalinks.attach();
    const themes = createThemeService({ hooks: np.hooks, logger: silentLogger });
    themes.register((await discoverThemes(root)).themes);
    themes.activate('demo');
    const app = createApp(np, database, {
      permalinks,
      themes: {
        service: themes,
        renderBody: createBodyRenderer({ hooks: np.hooks, logger: silentLogger }),
      },
    });
    await content.create({
      type: 'page',
      title: 'About',
      status: 'published',
      body: [
        { type: 'core/heading', attrs: { level: 2 }, text: 'Who we are' },
        { type: 'core/paragraph', text: 'We build <things>.' },
        {
          type: 'core/list',
          attrs: { ordered: false },
          children: [
            { type: 'core/list-item', text: 'one' },
            { type: 'core/list-item', text: 'two' },
          ],
        },
        { type: 'plugin/missing' },
      ],
    });
    const res = await app.request('http://localhost/about');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      '<article><h2>Who we are</h2><p>We build &lt;things&gt;.</p><ul><li>one</li><li>two</li></ul></article>',
    );
  });
});
