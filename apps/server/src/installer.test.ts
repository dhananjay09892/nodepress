import {
  createNodePress,
  createOptionsService,
  createSettingsService,
  createUsersService,
  silentLogger,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createDatabase,
  createOptionsStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createInstaller, type Installer } from './installer.js';
import { MIN_ADMIN_PASSWORD } from './installer-page.js';

const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};

const BASE = 'http://localhost';
const CODE = 'setup-code-1234';
const GOOD = {
  code: CODE,
  siteName: 'My Site',
  email: 'owner@example.com',
  password: 'long enough pw',
};

let database: DatabaseHandle;
let app: ReturnType<typeof createApp>;
let installer: Installer;
let users: ReturnType<typeof createUsersService>;
let settings: ReturnType<typeof createSettingsService>;
let installedName: string | undefined;

beforeEach(async () => {
  installedName = undefined;
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  const np = createNodePress({ logger: silentLogger });
  users = createUsersService({
    store: createUsersStore(database),
    hooks: np.hooks,
    hasher: fakeHasher,
  });
  settings = createSettingsService({
    options: createOptionsService({ store: createOptionsStore(database), hooks: np.hooks }),
  });
  installer = createInstaller({
    users,
    settings,
    dialect: 'sqlite',
    code: CODE,
    onInstalled: ({ siteName }) => {
      installedName = siteName;
    },
  });
  app = createApp(np, database, { installer, siteName: () => installedName ?? 'Before' });
});

afterEach(async () => {
  await database.close();
});

const post = (body: unknown, type = 'application/json') =>
  app.request(`${BASE}/api/v1/install`, {
    method: 'POST',
    headers: { 'content-type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('web installer', () => {
  it('sends visitors of a site without users to the wizard, but not API calls', async () => {
    const home = await app.request(`${BASE}/`, { redirect: 'manual' });
    expect(home.status).toBe(302);
    expect(home.headers.get('location')).toBe('/install');
    expect((await app.request(`${BASE}/some/page`, { redirect: 'manual' })).status).toBe(302);
    expect((await app.request(`${BASE}/api/health`)).status).not.toBe(302);
  });

  it('serves the wizard and its script, and reports the database check', async () => {
    const page = await app.request(`${BASE}/install`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('<script src="/install/install.js" defer></script>');
    expect(html).not.toMatch(/<script>/);
    for (const id of ['code', 'siteName', 'email', 'password', 'confirm']) {
      expect(html).toContain(`<label for="${id}">`);
    }
    expect(html).toContain('<link rel="stylesheet" href="/install/install.css">');
    expect(html).not.toContain('<style');
    const css = await app.request(`${BASE}/install/install.css`);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('--accent');
    const script = await app.request(`${BASE}/install/install.js`);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    const source = await script.text();
    expect(() => new Function(source)).not.toThrow();
    expect(await (await app.request(`${BASE}/api/v1/install/status`)).json()).toEqual({
      needsSetup: true,
      database: { dialect: 'sqlite', ok: true },
    });
  });

  it('creates the administrator and the site name with the right code', async () => {
    const res = await post(GOOD);
    expect(res.status).toBe(201);
    const [admin] = await users.list();
    expect(admin).toMatchObject({ email: 'owner@example.com', role: 'administrator' });
    expect((await settings.getAll()).site_title).toBe('My Site');
    expect(installedName).toBe('My Site');
    // Afterwards the wizard is gone and the site is no longer redirected.
    expect((await app.request(`${BASE}/install`, { redirect: 'manual' })).status).toBe(302);
    expect(
      (await app.request(`${BASE}/install`, { redirect: 'manual' })).headers.get('location'),
    ).toBe('/admin/');
    expect((await post(GOOD)).status).toBe(409);
    expect(await (await app.request(`${BASE}/api/v1/install/status`)).json()).toEqual({
      needsSetup: false,
    });
    expect((await app.request(`${BASE}/`, { redirect: 'manual' })).status).not.toBe(302);
  });

  it('refuses a wrong code without creating anything, and rate limits guesses', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await post({ ...GOOD, code: `wrong-${i}` });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_code' });
    }
    const blocked = await post(GOOD);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(await users.list()).toHaveLength(0);
  });

  it('reports field problems', async () => {
    const res = await post({ code: CODE, siteName: ' ', email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fields: Record<string, string> };
    expect(Object.keys(body.fields).sort()).toEqual(['email', 'password', 'siteName']);
    expect(body.fields.password).toContain(String(MIN_ADMIN_PASSWORD));
    expect(await users.list()).toHaveLength(0);
  });

  it('refuses other content types and broken JSON', async () => {
    expect((await post(JSON.stringify(GOOD), 'text/plain')).status).toBe(415);
    expect((await post('{not json')).status).toBe(400);
    expect((await post('[]')).status).toBe(400);
  });

  it('only one request creates the administrator when two arrive together', async () => {
    const results = await Promise.all([post(GOOD), post({ ...GOOD, email: 'other@example.com' })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await users.list()).toHaveLength(1);
  });
});
