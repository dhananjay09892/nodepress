import {
  createCapabilities,
  createNodePress,
  createOptionsService,
  createSessionsService,
  createSettingsService,
  createUsersService,
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

let database: DatabaseHandle;
let app: ReturnType<typeof createApp>;
let options: OptionsService;

beforeEach(async () => {
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
  options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
  app = createApp(np, database, {
    auth: { users, sessions },
    settings: {
      service: createSettingsService({ options, isPublishedPage: async (id) => id === 7 }),
      capabilities: createCapabilities(np.hooks),
    },
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

function call(method: string, headers: Record<string, string>, body?: unknown) {
  return app.request(`${BASE}/api/v1/settings`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Json = Record<string, unknown>;

describe('GET /api/v1/settings', () => {
  it('returns every setting with defaults, uncached', async () => {
    const res = await call('GET', await signIn('admin'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { settings: Json }).settings).toEqual({
      site_title: 'NodePress',
      tagline: '',
      timezone: 'UTC',
      front_page_id: null,
      posts_per_page: 10,
      discourage_search_engines: false,
      permalink_structure: '/blog/:slug',
      api_public_read: false,
    });
  });

  it('needs a sign-in and manage_options', async () => {
    expect((await call('GET', {})).status).toBe(401);
    expect((await call('GET', await signIn('editor'))).status).toBe(403);
  });
});

describe('PATCH /api/v1/settings', () => {
  it('saves settings, returns them all and persists them in the options table', async () => {
    const admin = await signIn('admin');
    const res = await call('PATCH', admin, {
      site_title: 'Field Notes',
      posts_per_page: 5,
      permalink_structure: '/:year/:slug',
      api_public_read: true,
      front_page_id: 7,
    });
    expect(res.status).toBe(200);
    const { settings } = (await res.json()) as { settings: Json };
    expect(settings).toMatchObject({
      site_title: 'Field Notes',
      posts_per_page: 5,
      permalink_structure: '/:year/:slug',
      api_public_read: true,
      front_page_id: 7,
      tagline: '',
    });
    expect(await options.get('site_title')).toBe('Field Notes');
    expect(await options.get('permalink_structure')).toBe('/:year/:slug');
    expect(await options.get('api_public_read')).toBe(true);

    const again = await call('GET', admin);
    expect(((await again.json()) as { settings: Json }).settings).toEqual(settings);
  });

  it('names the key of an invalid value and saves nothing', async () => {
    const admin = await signIn('admin');
    const res = await call('PATCH', admin, { site_title: 'Changed', posts_per_page: 500 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request', field: 'posts_per_page' });
    expect(await options.has('site_title')).toBe(false);
  });

  it.each([
    [{ timezone: 'Mars/Olympus' }, 'timezone'],
    [{ permalink_structure: '/:nope' }, 'permalink_structure'],
    [{ front_page_id: 8 }, 'front_page_id'],
    [{ api_public_read: 'yes' }, 'api_public_read'],
    [{ unknown_key: 1 }, 'unknown_key'],
  ])('refuses %j', async (body, field) => {
    const res = await call('PATCH', await signIn('admin'), body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field });
  });

  it('refuses a body that is not a JSON object, another content type or a huge body', async () => {
    const admin = await signIn('admin');
    expect((await call('PATCH', admin, [1])).status).toBe(400);
    const bad = await app.request(`${BASE}/api/v1/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...admin },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    const text = await app.request(`${BASE}/api/v1/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'text/plain', ...admin },
      body: '{}',
    });
    expect(text.status).toBe(415);
    const huge = await call('PATCH', admin, { tagline: 'x'.repeat(9000) });
    expect(huge.status).toBe(413);
  });

  it('denies other roles, anonymous callers and writes without a CSRF token', async () => {
    expect((await call('PATCH', await signIn('editor'), { tagline: 'x' })).status).toBe(403);
    expect((await call('PATCH', {}, { tagline: 'x' })).status).toBe(401);
    const { cookie } = await signIn('admin');
    expect((await call('PATCH', { cookie }, { tagline: 'x' })).status).toBe(403);
    expect(await options.has('tagline')).toBe(false);
  });
});
