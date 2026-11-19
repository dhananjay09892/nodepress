import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createContentService,
  createNodePress,
  type NodePress,
  createOptionsService,
  createPermalinkService,
  createThemeService,
  discoverThemes,
  silentLogger,
  type ContentService,
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
import { createApp } from './app.js';

const BASE = 'http://localhost';

let root: string;
let database: DatabaseHandle;
let content: ContentService;
let themes: ThemeService;
let app: Hono;
let np: NodePress;

/** Template files are plain ESM (.mjs so Node needs no package.json), like compiled TSX. */
async function writeTemplate(name: string, source: string): Promise<void> {
  await writeFile(join(root, 'demo', 'templates', `${name}.mjs`), source);
}

async function boot(options: { activate?: boolean } = {}): Promise<void> {
  const found = await discoverThemes(root);
  themes.register(found.themes);
  if (options.activate !== false) themes.activate('demo');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'np-server-themes-'));
  await mkdir(join(root, 'demo', 'templates'), { recursive: true });
  await mkdir(join(root, 'demo', 'assets'), { recursive: true });
  await writeFile(join(root, 'demo', 'theme.json'), JSON.stringify({ name: 'demo', version: '1.2.3' }));
  await writeFile(join(root, 'demo', 'assets', 'style.css'), 'body{color:red}');
  await writeFile(join(root, 'secret.txt'), 'top secret');

  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  np = createNodePress({ logger: silentLogger, config: { siteName: 'Test <Site>' } });
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
  app = createApp(np, database, {
    permalinks,
    themes: {
      service: themes,
      renderBody: (item) => `<p>body of ${item.slug}</p>`,
    },
  });
});

afterEach(async () => {
  await database.close();
  await rm(root, { recursive: true, force: true });
});

describe('theme rendering', () => {
  it('renders content with the most specific template and passes the page props', async () => {
    await writeTemplate(
      'index',
      `export default (p) => '<main>index ' + p.status + '</main>';`,
    );
    await writeTemplate(
      'single-post',
      `export default (p) =>
        '<article data-site="' + p.siteName + '" data-assets="' + p.theme.assetsUrl + '" data-v="' +
        p.theme.version + '">' + p.content.title + p.html + '</article>';`,
    );
    await boot();
    await content.create({ type: 'post', title: 'Hello', status: 'published' });
    const res = await app.request(`${BASE}/blog/hello`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<article data-site="Test <Site>"');
    expect(html).toContain('data-assets="/themes/demo/assets"');
    expect(html).toContain('data-v="1.2.3"');
    expect(html).toContain('Hello<p>body of hello</p></article>');
  });

  it('falls back through the hierarchy: page-{slug}, page, single, index', async () => {
    await writeTemplate('index', `export default () => 'index';`);
    await writeTemplate('single', `export default () => 'single';`);
    await boot();
    await content.create({ type: 'page', title: 'About', status: 'published' });
    expect(await (await app.request(`${BASE}/about`)).text()).toContain('single');
    await writeTemplate('page', `export default () => 'page';`);
    await writeTemplate('page-about', `export default () => 'page-about';`);
    themes.register((await discoverThemes(root)).themes);
    expect(await (await app.request(`${BASE}/about`)).text()).toContain('page-about');
  });

  it('draws the 404 page with the 404 template and a 404 status', async () => {
    await writeTemplate('index', `export default (p) => 'index ' + p.status;`);
    await writeTemplate('404', `export default (p) => 'nothing at ' + p.path;`);
    await boot();
    const res = await app.request(`${BASE}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('nothing at /nope');
  });

  it('applies the render:html filter to themed pages', async () => {
    await writeTemplate('index', `export default () => '<p>x</p>';`);
    await boot();
    np.hooks.addFilter('render:html', (html) => `${String(html)}<!-- filtered -->`);
    expect(await (await app.request(`${BASE}/nope`)).text()).toContain('<!-- filtered -->');
  });

  it('uses the built-in page when a template throws or no template matches', async () => {
    await writeTemplate('index', `export default () => { throw new Error('boom'); };`);
    await boot();
    await content.create({ type: 'post', title: 'Still works', status: 'published' });
    const res = await app.request(`${BASE}/blog/still-works`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>Still works</h1>');

    await rm(join(root, 'demo', 'templates', 'index.mjs'));
    themes.register((await discoverThemes(root)).themes);
    expect(await (await app.request(`${BASE}/blog/still-works`)).text()).toContain(
      '<h1>Still works</h1>',
    );
  });

  it('uses the built-in page when no theme is active', async () => {
    await writeTemplate('index', `export default () => 'themed';`);
    await boot({ activate: false });
    const res = await app.request(`${BASE}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Page not found');
  });
});

describe('theme assets', () => {
  it('serves files with cache headers, an ETag and the right type', async () => {
    await boot();
    const res = await app.request(`${BASE}/themes/demo/assets/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{20}"$/);
    expect(await res.text()).toBe('body{color:red}');

    const again = await app.request(`${BASE}/themes/demo/assets/style.css`, {
      headers: { 'if-none-match': etag! },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it('changes the ETag when the file changes', async () => {
    await boot();
    const first = (await app.request(`${BASE}/themes/demo/assets/style.css`)).headers.get('etag');
    await writeFile(join(root, 'demo', 'assets', 'style.css'), 'body{color:blue;margin:0}');
    await utimes(join(root, 'demo', 'assets', 'style.css'), new Date(), new Date(Date.now() + 5000));
    const second = (await app.request(`${BASE}/themes/demo/assets/style.css`)).headers.get('etag');
    expect(second).not.toBe(first);
  });

  it('answers 404 for unknown themes, missing files and directories', async () => {
    await boot();
    for (const path of [
      '/themes/other/assets/style.css',
      '/themes/demo/assets/missing.css',
      '/themes/demo/assets/',
      '/themes/demo/assets',
    ]) {
      expect((await app.request(`${BASE}${path}`)).status, path).toBe(404);
    }
  });

  it('does not let paths or symlinks leave the assets folder', async () => {
    await symlink(join(root, 'secret.txt'), join(root, 'demo', 'assets', 'link.txt'));
    await boot();
    for (const path of [
      '/themes/demo/assets/../../../secret.txt',
      '/themes/demo/assets/%2e%2e/theme.json',
      '/themes/demo/assets/..%2f..%2fsecret.txt',
      '/themes/demo/assets/..%5c..%5csecret.txt',
      '/themes/demo/assets/link.txt',
      '/themes/demo/assets/%00style.css',
    ]) {
      const res = await app.request(`${BASE}${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain('top secret');
    }
  });
});
