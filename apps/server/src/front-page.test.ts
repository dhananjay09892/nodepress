import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createContentService,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  createThemeService,
  discoverThemes,
  silentLogger,
  type ContentService,
  type NodePress,
  type ThemeService,
} from '@nodepress/core';
import {
  createContentStore,
  createDatabase,
  createOptionsStore,
  createSlugRedirectsStore,
  type DatabaseHandle,
} from '@nodepress/db';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from './app.js';
import { resolveThemeSettings } from './themes.js';

const BASE = 'http://localhost';

let root: string;
let database: DatabaseHandle;
let content: ContentService;
let themes: ThemeService;
let np: NodePress;
let build: (themeOptions?: Partial<NonNullable<AppOptions['themes']>>) => Hono;

async function boot(frontSource: string | null): Promise<void> {
  if (frontSource !== null) {
    await writeFile(join(root, 'demo', 'templates', 'front.mjs'), frontSource);
  }
  themes.register((await discoverThemes(root)).themes);
  themes.activate('demo');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'np-front-'));
  await mkdir(join(root, 'demo', 'templates'), { recursive: true });
  await writeFile(
    join(root, 'demo', 'theme.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      settings: { layout: { type: 'select', options: ['blog', 'business'], default: 'blog' } },
    }),
  );
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  np = createNodePress({ logger: silentLogger, config: { siteName: 'Front <Site>' } });
  const store = createContentStore(database);
  content = createContentService({ store, hooks: np.hooks });
  const permalinks = createPermalinkService({
    store,
    redirects: createSlugRedirectsStore(database),
    options: createOptionsService({ store: createOptionsStore(database), hooks: np.hooks }),
    hooks: np.hooks,
  });
  permalinks.attach();
  themes = createThemeService({ hooks: np.hooks, logger: silentLogger });
  build = (themeOptions = {}) =>
    createApp(np, database, { permalinks, themes: { service: themes, ...themeOptions } });
});

afterEach(async () => {
  await database.close();
  await rm(root, { recursive: true, force: true });
});

const latest = () =>
  content.list({ type: 'post', status: 'published', orderBy: 'publishedAt', limit: 10 });

describe('front page', () => {
  it('is drawn by the theme front template with posts, tagline and settings', async () => {
    await boot(
      `export default (p) => '<h1>' + p.siteName + '</h1><p>' + p.tagline + '</p>' +
        '<i>' + p.settings.layout + '</i><b>' + p.html + '</b>' +
        p.posts.map((x) => '<a href="' + x.url + '">' + x.content.title + '</a>').join('');`,
    );
    await content.create({ type: 'post', title: 'One', status: 'published' });
    await content.create({ type: 'post', title: 'Draft', status: 'draft' });
    const app = build({
      latestPosts: latest,
      tagline: () => 'All about it',
      settings: () => ({ layout: 'business', bogus: 1 }),
    });
    const res = await app.request(`${BASE}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<h1>Front <Site></h1>');
    expect(html).toContain('<p>All about it</p>');
    expect(html).toContain('<i>business</i>');
    expect(html).toContain('<a href="/blog/one">One</a>');
    expect(html).not.toContain('Draft');
    expect(html).toContain('Welcome to your new site.');
  });

  it('runs the post:content filter on the intro and the render:html filter on the page', async () => {
    await boot(`export default (p) => '<main>' + p.html + '</main>';`);
    np.hooks.addFilter('post:content', (html) => `${String(html)}<p>Thanks for reading!</p>`);
    np.hooks.addFilter('render:html', (html) => `${String(html)}<!-- filtered -->`);
    const html = await (await build().request(`${BASE}/`)).text();
    expect(html).toContain('Thanks for reading!');
    expect(html).toContain('<!-- filtered -->');
  });

  it('falls back to index when the theme has no front template, with safe defaults', async () => {
    await writeFile(
      join(root, 'demo', 'templates', 'index.mjs'),
      `export default (p) => 'index ' + p.settings.layout + ' [' + p.tagline + '] ' + p.posts;`,
    );
    await boot(null);
    const html = await (await build().request(`${BASE}/`)).text();
    expect(html).toContain('index blog [] undefined');
  });

  it('uses the built-in page when a theme template throws', async () => {
    await boot(`export default () => { throw new Error('boom'); };`);
    const broken = await build().request(`${BASE}/`);
    expect(broken.status).toBe(200);
    expect(await broken.text()).toContain('<h1>Front &lt;Site&gt;</h1>');
  });

  it('uses the built-in page when no theme is active', async () => {
    const html = await (await build().request(`${BASE}/`)).text();
    expect(html).toContain('<h1>Front &lt;Site&gt;</h1>');
    expect(html).toContain('Welcome to your new site.');
  });

  it('survives failing providers by using the built-in page', async () => {
    await boot(`export default () => 'themed';`);
    const app = build({
      latestPosts: () => Promise.reject(new Error('db down')),
    });
    const html = await (await app.request(`${BASE}/`)).text();
    expect(html).toContain('<h1>Front &lt;Site&gt;</h1>');
    expect(html).not.toContain('themed');
  });
});

describe('resolveThemeSettings', () => {
  const schema = {
    layout: { type: 'select', options: ['blog', 'business'], default: 'blog' },
    accent: { type: 'string', default: 'blue' },
    wide: { type: 'boolean', default: false },
    size: { type: 'number', default: 3 },
    broken: 'not an object',
    nodefault: { type: 'select', options: ['a'] },
  };

  it('returns the defaults without overrides', () => {
    expect(resolveThemeSettings(schema)).toEqual({
      layout: 'blog',
      accent: 'blue',
      wide: false,
      size: 3,
    });
  });

  it('applies valid overrides and ignores bad values and unknown keys', () => {
    expect(
      resolveThemeSettings(schema, {
        layout: 'business',
        accent: 5,
        wide: true,
        size: 'big',
        extra: 'x',
        nodefault: 'a',
      }),
    ).toEqual({ layout: 'business', accent: 'blue', wide: true, size: 3, nodefault: 'a' });
    expect(resolveThemeSettings(schema, { layout: 'neon' }).layout).toBe('blog');
  });

  it('returns nothing for an empty schema', () => {
    expect(resolveThemeSettings({}, { layout: 'business' })).toEqual({});
  });
});
