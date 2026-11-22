import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCapabilities,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  createSessionsService,
  createThemeService,
  createUsersService,
  discoverThemes,
  silentLogger,
  type PasswordHasher,
  type ThemeService,
} from '@nodepress/core';
import {
  createContentStore,
  createDatabase,
  createOptionsStore,
  createSessionsStore,
  createSlugRedirectsStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { ThemeSettingsService } from './theme-settings.js';

const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};

const PASSWORD = 'correct horse battery staple';
const BASE = 'http://localhost';

let root: string;
let database: DatabaseHandle;
let app: ReturnType<typeof createApp>;
let settings: ThemeSettingsService;
let themes: ThemeService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'np-server-theme-settings-'));
  await mkdir(join(root, 'demo', 'templates'), { recursive: true });
  await writeFile(
    join(root, 'demo', 'theme.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      settings: {
        accent: { type: 'color', label: 'Accent', default: '#0b5cad' },
        layout: { type: 'select', options: ['blog', 'business'], default: 'blog' },
      },
    }),
  );
  await writeFile(
    join(root, 'demo', 'templates', 'index.mjs'),
    `export default (p) => '<i>' + JSON.stringify(p.settings) + '</i>' + (p.settingsCssUrl ? '<link rel="stylesheet" href="' + p.settingsCssUrl + '">' : '');`,
  );
  // A `style` template turns the settings into a stylesheet (inline styles are blocked by the CSP).
  await writeFile(
    join(root, 'demo', 'templates', 'style.mjs'),
    `export default (p) => p.settings.accent === '#0b5cad' ? '' : ':root{--accent:' + p.settings.accent + '}';`,
  );

  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  const np = createNodePress({ logger: silentLogger });
  const users = createUsersService({
    store: createUsersStore(database),
    hooks: np.hooks,
    hasher: fakeHasher,
  });
  const sessions = createSessionsService({
    store: createSessionsStore(database),
    users,
    hooks: np.hooks,
  });
  for (const [name, role] of [
    ['admin', 'administrator'],
    ['editor', 'editor'],
  ] as const) {
    await users.create({ email: `${name}@example.com`, password: PASSWORD, role });
  }
  const options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
  settings = new ThemeSettingsService(options);
  const store = createContentStore(database);
  const permalinks = createPermalinkService({
    store,
    redirects: createSlugRedirectsStore(database),
    options,
    hooks: np.hooks,
  });
  permalinks.attach();
  themes = createThemeService({ hooks: np.hooks, logger: silentLogger });
  themes.register((await discoverThemes(root)).themes);
  themes.activate('demo');
  app = createApp(np, database, {
    auth: { users, sessions },
    permalinks,
    themes: {
      service: themes,
      settings: async () => ({
        ...(await settings.saved('demo', themes.active!.manifest.settings)),
      }),
    },
    themeSettings: { service: settings, capabilities: createCapabilities(np.hooks) },
  });
});

afterEach(async () => {
  await database.close();
  await rm(root, { recursive: true, force: true });
});

async function signIn(name: string) {
  const res = await app.request(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.com`, password: PASSWORD }),
  });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  return { cookie, 'x-csrf-token': csrfToken };
}

function call(path: string, method: string, headers: Record<string, string>, body?: unknown) {
  return app.request(`${BASE}/api/v1/${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Json = Record<string, unknown>;

const shown = (html: string): Json => JSON.parse(html.match(/<i>(.*)<\/i>/s)![1]!) as Json;

describe('/api/v1/theme-settings', () => {
  it('describes the settings and returns saved and effective values', async () => {
    const admin = await signIn('admin');
    const res = await call('theme-settings', 'GET', admin);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Json;
    expect(body.theme).toEqual({ name: 'demo', title: 'demo' });
    expect(body.settings).toEqual([
      { key: 'accent', type: 'color', label: 'Accent', default: '#0b5cad' },
      {
        key: 'layout',
        type: 'select',
        label: 'layout',
        options: ['blog', 'business'],
        default: 'blog',
      },
    ]);
    expect(body.saved).toEqual({});
    expect(body.values).toEqual({ accent: '#0b5cad', layout: 'blog' });
  });

  it('saves values, resets one with null and shows them on the front page', async () => {
    const admin = await signIn('admin');
    const saved = await call('theme-settings', 'PATCH', admin, {
      values: { accent: '#aa0000', layout: 'business' },
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Json).values).toEqual({
      accent: '#aa0000',
      layout: 'business',
    });
    expect(shown(await (await app.request(`${BASE}/`)).text())).toEqual({
      accent: '#aa0000',
      layout: 'business',
    });

    const reset = await call('theme-settings', 'PATCH', admin, { values: { accent: null } });
    const body = (await reset.json()) as Json;
    expect(body.saved).toEqual({ layout: 'business' });
    expect(body.values).toEqual({ accent: '#0b5cad', layout: 'business' });
  });

  it('refuses unknown settings and bad values, naming the field, and saves nothing', async () => {
    const admin = await signIn('admin');
    const unknown = await call('theme-settings', 'PATCH', admin, { values: { nope: 1 } });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: 'invalid_request', field: 'nope' });
    const bad = await call('theme-settings', 'PATCH', admin, {
      values: { layout: 'business', accent: 'red' },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: 'accent' });
    expect((await call('theme-settings', 'PATCH', admin, { values: [] })).status).toBe(400);
    expect((await call('theme-settings', 'PATCH', admin, {})).status).toBe(400);
    expect(await settings.saved('demo', themes.active!.manifest.settings)).toEqual({});
  });

  it('needs a sign-in, edit_theme_options and the CSRF token', async () => {
    expect((await call('theme-settings', 'GET', {})).status).toBe(401);
    const editor = await signIn('editor');
    expect((await call('theme-settings', 'GET', editor)).status).toBe(403);
    expect(
      (await call('theme-settings', 'PATCH', editor, { values: { layout: 'business' } })).status,
    ).toBe(403);
    const { cookie } = await signIn('admin');
    expect(
      (await call('theme-settings', 'PATCH', { cookie }, { values: { layout: 'business' } }))
        .status,
    ).toBe(403);
    expect(await settings.saved('demo', themes.active!.manifest.settings)).toEqual({});
  });

  it('ignores a stale saved value that no longer fits the schema', async () => {
    await settings.update('demo', themes.active!.manifest.settings, { layout: 'business' });
    const shrunk = { layout: { type: 'select', options: ['blog'], default: 'blog' } };
    expect(await settings.saved('demo', shrunk)).toEqual({});
  });
});

describe('preview with ?np_preview', () => {
  const preview = (values: unknown, headers: Record<string, string> = {}) =>
    app.request(`${BASE}/?np_preview=${encodeURIComponent(JSON.stringify(values))}`, { headers });

  it('shows unsaved values to a signed-in administrator without saving them', async () => {
    const admin = await signIn('admin');
    await call('theme-settings', 'PATCH', admin, { values: { layout: 'business' } });
    const res = await preview({ accent: '#00aa00', layout: 'nonsense' }, { cookie: admin.cookie });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    // The bad layout value falls back to the schema default, the valid accent is shown.
    expect(shown(await res.text())).toEqual({ accent: '#00aa00', layout: 'blog' });
    expect(await settings.saved('demo', themes.active!.manifest.settings)).toEqual({
      layout: 'business',
    });
  });

  it('is ignored for visitors and for users without edit_theme_options', async () => {
    const editor = await signIn('editor');
    for (const headers of [{}, { cookie: editor.cookie }]) {
      const res = await preview({ accent: '#00aa00' }, headers);
      expect(shown(await res.text())).toEqual({ accent: '#0b5cad', layout: 'blog' });
    }
  });

  it('ignores a broken or oversized preview value', async () => {
    const admin = await signIn('admin');
    const broken = await app.request(`${BASE}/?np_preview=%7B`, {
      headers: { cookie: admin.cookie },
    });
    expect(shown(await broken.text())).toEqual({ accent: '#0b5cad', layout: 'blog' });
    const big = await preview(
      { accent: '#00aa00', pad: 'x'.repeat(5000) },
      { cookie: admin.cookie },
    );
    expect(shown(await big.text())).toEqual({ accent: '#0b5cad', layout: 'blog' });
    const array = await preview([1], { cookie: admin.cookie });
    expect(shown(await array.text())).toEqual({ accent: '#0b5cad', layout: 'blog' });
  });
});

describe('the stylesheet made from the settings', () => {
  const cssUrl = (html: string) => /href="(\/np\/theme\.css[^"]*)"/.exec(html)?.[1];

  it('adds no link while the settings make no CSS', async () => {
    const html = await (await app.request(`${BASE}/`)).text();
    expect(cssUrl(html)).toBeUndefined();
    const css = await app.request(`${BASE}/np/theme.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toBe('');
  });

  it('links a stylesheet whose address changes with its content and serves the CSS', async () => {
    await settings.update('demo', themes.active!.manifest.settings, { accent: '#aa0000' });
    const first = cssUrl(await (await app.request(`${BASE}/`)).text());
    expect(first).toMatch(/^\/np\/theme\.css\?v=[0-9a-f]{12}$/);
    const res = await app.request(`${BASE}${first}`);
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await res.text()).toBe(':root{--accent:#aa0000}');

    await settings.update('demo', themes.active!.manifest.settings, { accent: '#00aa00' });
    const second = cssUrl(await (await app.request(`${BASE}/`)).text());
    expect(second).not.toBe(first);
    expect(await (await app.request(`${BASE}${second}`)).text()).toBe(':root{--accent:#00aa00}');
  });

  it('serves unsaved values only to someone who may edit theme options, and never caches them', async () => {
    const admin = await signIn('admin');
    const editor = await signIn('editor');
    const url = `${BASE}/np/theme.css?np_preview=${encodeURIComponent(JSON.stringify({ accent: '#123456' }))}`;
    const forAdmin = await app.request(url, { headers: { cookie: admin.cookie } });
    expect(forAdmin.headers.get('cache-control')).toBe('no-store');
    expect(await forAdmin.text()).toBe(':root{--accent:#123456}');
    for (const headers of [{}, { cookie: editor.cookie }]) {
      expect(await (await app.request(url, { headers })).text()).toBe('');
    }
    // The preview page links the preview stylesheet so the frame shows the unsaved look.
    const page = await app.request(
      `${BASE}/?np_preview=${encodeURIComponent(JSON.stringify({ accent: '#123456' }))}`,
      { headers: { cookie: admin.cookie } },
    );
    expect(cssUrl(await page.text())).toContain('np_preview=');
  });
});
