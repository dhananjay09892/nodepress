import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCapabilities,
  createMenuService,
  createNodePress,
  createOptionsService,
  createPermalinkService,
  createSessionsService,
  createThemeService,
  createUsersService,
  discoverThemes,
  silentLogger,
  type MenuService,
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
let menus: MenuService;
let themes: ThemeService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'np-server-menus-'));
  await mkdir(join(root, 'demo', 'templates'), { recursive: true });
  await writeFile(
    join(root, 'demo', 'theme.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      menus: { primary: 'Primary menu', footer: 'Footer menu' },
    }),
  );
  await writeFile(
    join(root, 'demo', 'templates', 'index.mjs'),
    `export default (p) => '<nav>' + JSON.stringify(p.menus) + '</nav>';`,
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
  menus = createMenuService({ options });
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
    menus: { service: menus, capabilities: createCapabilities(np.hooks) },
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

type Json = Record<string, any>;
const item = (label: string, url: string) => ({ label, url });

describe('/api/v1/menus', () => {
  it('creates, lists, reads, updates and deletes a menu', async () => {
    const admin = await signIn('admin');
    const created = await call('menus', 'POST', admin, {
      name: 'Main',
      items: [{ ...item('Home', '/'), children: [item('Docs', '/docs')] }, item('About', '/about')],
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const { menu } = (await created.json()) as Json;
    expect(menu).toEqual({
      id: 1,
      name: 'Main',
      items: [
        { label: 'Home', url: '/', children: [{ label: 'Docs', url: '/docs', children: [] }] },
        { label: 'About', url: '/about', children: [] },
      ],
    });

    expect(((await (await call('menus', 'GET', admin)).json()) as Json).menus).toEqual([menu]);
    expect(((await (await call('menus/1', 'GET', admin)).json()) as Json).menu).toEqual(menu);

    const patched = await call('menus/1', 'PATCH', admin, { name: 'Primary', items: [] });
    expect(((await patched.json()) as Json).menu).toEqual({ id: 1, name: 'Primary', items: [] });

    expect((await call('menus/1', 'DELETE', admin)).status).toBe(204);
    expect((await call('menus/1', 'GET', admin)).status).toBe(404);
    expect((await call('menus/1', 'DELETE', admin)).status).toBe(404);
  });

  it('refuses bad input, naming the field, and saves nothing', async () => {
    const admin = await signIn('admin');
    const bad = await call('menus', 'POST', admin, {
      name: 'Main',
      items: [item('Fine', '/'), item('Evil', 'javascript:alert(1)')],
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_request', field: 'items[1].url' });
    expect(((await (await call('menus', 'GET', admin)).json()) as Json).menus).toEqual([]);

    expect((await call('menus', 'POST', admin, { name: '' })).status).toBe(400);
    expect((await call('menus', 'POST', admin, [])).status).toBe(400);
    expect((await call('menus/9', 'PATCH', admin, { name: 'x' })).status).toBe(404);
    expect((await call('menus/abc', 'GET', admin)).status).toBe(404);
    const notJson = await app.request(`${BASE}/api/v1/menus`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(notJson.status).toBe(415);
    const broken = await app.request(`${BASE}/api/v1/menus`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: '{',
    });
    expect(broken.status).toBe(400);
  });

  it('needs a sign-in and edit_theme_options', async () => {
    expect((await call('menus', 'GET', {})).status).toBe(401);
    const editor = await signIn('editor');
    expect((await call('menus', 'GET', editor)).status).toBe(403);
    expect((await call('menus', 'POST', editor, { name: 'x' })).status).toBe(403);
    expect((await call('menu-locations', 'GET', editor)).status).toBe(403);
    expect(await menus.list()).toEqual([]);
  });

  it('rejects a cookie-authenticated write without the CSRF token', async () => {
    const { cookie } = await signIn('admin');
    const res = await call('menus', 'POST', { cookie }, { name: 'x' });
    expect(res.status).toBe(403);
    expect(await menus.list()).toEqual([]);
  });
});

describe('/api/v1/menu-locations', () => {
  it('lists the active theme locations and assigns, then clears, a menu', async () => {
    const admin = await signIn('admin');
    await call('menus', 'POST', admin, { name: 'Main', items: [item('Home', '/')] });

    const first = (await (await call('menu-locations', 'GET', admin)).json()) as Json;
    expect(first).toEqual({
      locations: { primary: 'Primary menu', footer: 'Footer menu' },
      assigned: {},
    });

    const put = await call('menu-locations', 'PUT', admin, { primary: 1 });
    expect(((await put.json()) as Json).assigned).toEqual({ primary: 1 });
    const cleared = await call('menu-locations', 'PUT', admin, { primary: null });
    expect(((await cleared.json()) as Json).assigned).toEqual({});
  });

  it('refuses unknown locations and menus that do not exist', async () => {
    const admin = await signIn('admin');
    const unknown = await call('menu-locations', 'PUT', admin, { sidebar: 1 });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ field: 'sidebar' });
    const missing = await call('menu-locations', 'PUT', admin, { primary: 5 });
    expect(missing.status).toBe(400);
    expect(await menus.getLocations()).toEqual({});
  });

  it('frees the location when its menu is deleted', async () => {
    const admin = await signIn('admin');
    await call('menus', 'POST', admin, { name: 'Main' });
    await call('menu-locations', 'PUT', admin, { footer: 1 });
    await call('menus/1', 'DELETE', admin);
    const after = (await (await call('menu-locations', 'GET', admin)).json()) as Json;
    expect(after.assigned).toEqual({});
  });
});

describe('themes receive the assigned menus', () => {
  it('passes menus by location to the template, leaving out unassigned locations', async () => {
    const admin = await signIn('admin');
    await call('menus', 'POST', admin, { name: 'Main', items: [item('Home', '/')] });
    await call('menu-locations', 'PUT', admin, { primary: 1 });
    const html = await (await app.request(`${BASE}/`)).text();
    expect(html).toContain('<nav>{"primary":[{"label":"Home","url":"/","children":[]}]}</nav>');
  });

  it('passes an empty object when nothing is assigned', async () => {
    const html = await (await app.request(`${BASE}/`)).text();
    expect(html).toContain('<nav>{}</nav>');
  });
});
