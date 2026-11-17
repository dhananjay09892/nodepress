import {
  createCapabilities,
  createNodePress,
  createOptionsService,
  createSessionsService,
  createUsersService,
  definePlugin,
  silentLogger,
  type OptionsService,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createDatabase,
  createOptionsStore,
  createSessionsStore,
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
const URL_BASE = `${BASE}/api/v1/admin-extensions`;

const statsPlugin = definePlugin({
  name: 'stats',
  setup({ admin }) {
    admin.addPage({
      id: 'general',
      title: 'Stats settings',
      panels: [
        {
          id: 'tracking',
          title: 'Tracking',
          fields: [
            { name: 'site_id', type: 'text', maxLength: 20 },
            { name: 'sample_rate', type: 'number', min: 0, max: 100, default: 100 },
          ],
        },
      ],
    });
    admin.addMenuItem({ id: 'stats', label: 'Stats', page: 'general' });
    // Open to everyone who can edit posts, so an editor can use it and a subscriber cannot.
    admin.addPage({
      id: 'notes',
      title: 'Editor notes',
      capability: 'edit_posts',
      panels: [{ id: 'main', title: 'Notes', fields: [{ name: 'note', type: 'text' }] }],
    });
    admin.addMenuItem({ id: 'notes', label: 'Notes', page: 'notes', order: 1 });
  },
});

let database: DatabaseHandle;
let app: ReturnType<typeof createApp>;
let options: OptionsService;

beforeEach(async () => {
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  const np = createNodePress({ logger: silentLogger, plugins: [statsPlugin] });
  await np.boot();
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
    ['subscriber', 'subscriber'],
  ] as const) {
    await users.create({ email: `${name}@example.com`, password: PASSWORD, role });
  }
  options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
  np.admin.useOptions(options);
  app = createApp(np, database, {
    auth: { users, sessions },
    adminExtensions: { capabilities: createCapabilities(np.hooks) },
  });
});

afterEach(async () => {
  await database.close();
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

function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return app.request(`${URL_BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Test-only shorthand for response bodies.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

describe('GET /api/v1/admin-extensions', () => {
  it('needs a sign-in', async () => {
    expect((await call('GET', '', {})).status).toBe(401);
  });

  it('lists menu items and pages for an administrator, in menu order', async () => {
    const res = await call('GET', '', await signIn('admin'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Json;
    expect(body.menu).toEqual([
      { plugin: 'stats', id: 'notes', label: 'Notes', page: 'notes' },
      { plugin: 'stats', id: 'stats', label: 'Stats', page: 'general' },
    ]);
    expect(body.pages.map((p: Json) => p.id)).toEqual(['general', 'notes']);
    expect(body.pages[0].panels[0].fields[0].name).toBe('site_id');
  });

  it('leaves out what the person may not use', async () => {
    const editor = (await (await call('GET', '', await signIn('editor'))).json()) as Json;
    expect(editor.menu.map((m: Json) => m.id)).toEqual(['notes']);
    const subscriber = (await (await call('GET', '', await signIn('subscriber'))).json()) as Json;
    expect(subscriber).toEqual({ menu: [], pages: [] });
  });
});

describe('GET /api/v1/admin-extensions/:plugin/:page', () => {
  it('returns panel values with defaults', async () => {
    const res = await call('GET', '/stats/general', await signIn('admin'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ values: { tracking: { sample_rate: 100 } } });
  });

  it('is 404 for an unknown page and 403 without the capability', async () => {
    expect((await call('GET', '/stats/nope', await signIn('admin'))).status).toBe(404);
    expect((await call('GET', '/nope/general', await signIn('admin'))).status).toBe(404);
    expect((await call('GET', '/stats/general', await signIn('editor'))).status).toBe(403);
    expect((await call('GET', '/stats/notes', await signIn('subscriber'))).status).toBe(403);
    expect((await call('GET', '/stats/notes', await signIn('editor'))).status).toBe(200);
  });
});

describe('PATCH /api/v1/admin-extensions/:plugin/:page/:panel', () => {
  it('saves the fields sent, persists them and returns the panel', async () => {
    const admin = await signIn('admin');
    const res = await call('PATCH', '/stats/general/tracking', admin, {
      site_id: 'abc',
      sample_rate: 40,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ values: { site_id: 'abc', sample_rate: 40 } });
    expect(await options.get('admin-ext:stats:general:tracking')).toEqual({
      site_id: 'abc',
      sample_rate: 40,
    });
    const again = await call('GET', '/stats/general', admin);
    expect(await again.json()).toEqual({
      values: { tracking: { site_id: 'abc', sample_rate: 40 } },
    });
  });

  it('names the field of an invalid value and saves nothing', async () => {
    const res = await call('PATCH', '/stats/general/tracking', await signIn('admin'), {
      site_id: 'ok',
      sample_rate: 500,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Json;
    expect(body).toMatchObject({ error: 'invalid_request', field: 'sample_rate' });
    expect(await options.get('admin-ext:stats:general:tracking')).toBeUndefined();
  });

  it('rejects unknown fields, non-object bodies and bad JSON', async () => {
    const admin = await signIn('admin');
    expect((await call('PATCH', '/stats/general/tracking', admin, { nope: 1 })).status).toBe(400);
    expect((await call('PATCH', '/stats/general/tracking', admin, [1])).status).toBe(400);
    const bad = await app.request(`${URL_BASE}/stats/general/tracking`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...admin },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    const wrongType = await app.request(`${URL_BASE}/stats/general/tracking`, {
      method: 'PATCH',
      headers: { 'content-type': 'text/plain', ...admin },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);
  });

  it('is 404 for an unknown panel, 403 without the capability, 401 without a session', async () => {
    expect((await call('PATCH', '/stats/general/nope', await signIn('admin'), {})).status).toBe(
      404,
    );
    expect(
      (await call('PATCH', '/stats/general/tracking', await signIn('editor'), { site_id: 'x' }))
        .status,
    ).toBe(403);
    expect((await call('PATCH', '/stats/general/tracking', {}, { site_id: 'x' })).status).toBe(401);
    expect(await options.get('admin-ext:stats:general:tracking')).toBeUndefined();
  });

  it('rejects a cookie-authenticated write without the CSRF token', async () => {
    const { cookie } = await signIn('admin');
    const res = await call('PATCH', '/stats/general/tracking', { cookie }, { site_id: 'x' });
    expect(res.status).toBe(403);
    expect(await options.get('admin-ext:stats:general:tracking')).toBeUndefined();
  });
});
