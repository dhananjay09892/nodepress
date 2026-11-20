import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCapabilities,
  createMenuService,
  createWidgetService,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  createSessionsService,
  createThemeService,
  createUsersService,
  discoverThemes,
  silentLogger,
  type WidgetService,
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

const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};

const PASSWORD = 'correct horse battery staple';
const BASE = 'http://localhost';

let root: string;
let database: DatabaseHandle;
let app: ReturnType<typeof createApp>;
let widgets: WidgetService;
let themes: ThemeService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'np-server-widgets-'));
  await mkdir(join(root, 'demo', 'templates'), { recursive: true });
  await writeFile(
    join(root, 'demo', 'theme.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      widgetAreas: { sidebar: 'Sidebar', footer: 'Footer' },
    }),
  );
  await writeFile(
    join(root, 'demo', 'templates', 'index.mjs'),
    `export default (p) => '<aside>' + JSON.stringify(p.widgets) + '</aside>';`,
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
  const menus = createMenuService({ options });
  widgets = createWidgetService({ options, hooks: np.hooks, getMenu: (id) => menus.get(id) });
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
    themes: { service: themes },
    widgets: { service: widgets, capabilities: createCapabilities(np.hooks) },
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
const text = (value: string, title?: string) => ({
  type: 'text',
  settings: { text: value, ...(title ? { title } : {}) },
});

describe('/api/v1/widgets', () => {
  it('lists the theme areas, their widgets and the available types', async () => {
    const admin = await signIn('admin');
    const res = await call('widgets', 'GET', admin);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Json;
    expect(body.areas).toEqual({ sidebar: 'Sidebar', footer: 'Footer' });
    expect(body.widgets).toEqual({ sidebar: [], footer: [] });
    expect((body.types as Array<{ type: string }>).map((t) => t.type)).toEqual([
      'text',
      'menu',
      'recent-posts',
    ]);
  });

  it('saves the widgets of an area in order and returns the overview', async () => {
    const admin = await signIn('admin');
    const res = await call('widgets', 'PUT', admin, {
      sidebar: [text('First', 'Hello'), text('Second')],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { widgets: Record<string, Array<Json>> };
    expect(body.widgets.sidebar!.map((w) => (w.settings as Json).text)).toEqual([
      'First',
      'Second',
    ]);
    expect(body.widgets.footer).toEqual([]);
    const again = (await (await call('widgets', 'GET', admin)).json()) as typeof body;
    expect(again.widgets).toEqual(body.widgets);
  });

  it('refuses bad input naming the field, and saves nothing', async () => {
    const admin = await signIn('admin');
    const bad = await call('widgets', 'PUT', admin, { sidebar: [text('ok'), { type: 'text' }] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: 'invalid_request',
      field: 'sidebar[1].settings',
    });
    const unknownArea = await call('widgets', 'PUT', admin, { header: [] });
    expect(unknownArea.status).toBe(400);
    expect(await unknownArea.json()).toMatchObject({ field: 'header' });
    expect(await widgets.getAreas(['sidebar'])).toEqual({ sidebar: [] });
    expect((await call('widgets', 'PUT', admin, [])).status).toBe(400);
    const notJson = await app.request(`${BASE}/api/v1/widgets`, {
      method: 'PUT',
      headers: { ...admin, 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(notJson.status).toBe(415);
  });

  it('needs a sign-in, edit_theme_options and the CSRF token', async () => {
    expect((await call('widgets', 'GET', {})).status).toBe(401);
    const editor = await signIn('editor');
    expect((await call('widgets', 'GET', editor)).status).toBe(403);
    expect((await call('widgets', 'PUT', editor, { sidebar: [text('x')] })).status).toBe(403);
    const { cookie } = await signIn('admin');
    expect((await call('widgets', 'PUT', { cookie }, { sidebar: [text('x')] })).status).toBe(403);
    expect(await widgets.getAreas(['sidebar'])).toEqual({ sidebar: [] });
  });
});

describe('widgets on the front end', () => {
  it('passes the rendered widgets of each area to the template, leaving empty areas out', async () => {
    const admin = await signIn('admin');
    await call('widgets', 'PUT', admin, { sidebar: [text('Hi <there>', 'About')] });
    const page = await (await app.request(`${BASE}/`)).text();
    const json = JSON.parse(page.match(/<aside>(.*)<\/aside>/s)![1]!) as Record<string, unknown[]>;
    expect(Object.keys(json)).toEqual(['sidebar']);
    expect(json.sidebar).toMatchObject([
      { type: 'text', title: 'About', html: '<p>Hi &lt;there&gt;</p>' },
    ]);
  });
});
