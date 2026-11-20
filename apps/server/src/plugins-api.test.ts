import {
  createApiTokensService,
  createCapabilities,
  createNodePress,
  createSessionsService,
  createUsersService,
  PluginStateService,
  silentLogger,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createDatabase,
  createPluginsStore,
  createSessionsStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createTestZip } from './test-zip.js';

const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};
const PASSWORD = 'correct horse battery staple';
const BASE = 'http://localhost';

let database: DatabaseHandle;
let app: ReturnType<typeof createApp>;
let root: string;
let dir: string;
let loaded: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'np-plugins-api-'));
  dir = join(root, 'plugins');
  loaded = [];
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
  const apiTokens = createApiTokensService({
    store: createApiTokensStore(database),
    users,
    hooks: np.hooks,
  });
  for (const [email, role] of [
    ['admin@example.com', 'administrator'],
    ['editor@example.com', 'editor'],
  ] as const) {
    await users.create({ email, password: PASSWORD, role });
  }
  app = createApp(np, database, {
    auth: { users, sessions, apiTokens },
    plugins: {
      dir,
      state: new PluginStateService(createPluginsStore(database)),
      capabilities: createCapabilities(np.hooks),
      running: () => [],
      loaded: () => loaded,
    },
  });
});

afterEach(async () => {
  await database.close();
  await rm(root, { recursive: true, force: true });
});

async function signIn(email: string) {
  const res = await app.request(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  return { cookie, 'x-csrf-token': csrfToken };
}

const pluginZip = (name = 'notes', extra: Record<string, unknown> = {}) =>
  createTestZip([
    {
      name: 'plugin.json',
      data: JSON.stringify({
        name,
        version: '1.2.0',
        title: 'Notes',
        permissions: ['content:read', 'network'],
        ...extra,
      }),
    },
    { name: 'index.js', data: `export default { name: '${name}', setup() {} };` },
  ]);

function upload(headers: Record<string, string>, zip: Uint8Array, type = 'application/zip') {
  return app.request(`${BASE}/api/v1/plugins`, {
    method: 'POST',
    headers: { 'content-type': type, ...headers },
    body: zip,
  });
}

function patch(headers: Record<string, string>, name: string, body: unknown) {
  return app.request(`${BASE}/api/v1/plugins/${name}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

type Json = Record<string, unknown>;

describe('/api/v1/plugins', () => {
  it('needs the manage_plugins capability', async () => {
    expect((await app.request(`${BASE}/api/v1/plugins`)).status).toBe(401);
    const editor = await signIn('editor@example.com');
    expect((await app.request(`${BASE}/api/v1/plugins`, { headers: editor })).status).toBe(403);
    expect((await upload(editor, pluginZip())).status).toBe(403);
    expect((await patch(editor, 'notes', { enabled: true })).status).toBe(403);
  });

  it('starts empty', async () => {
    const admin = await signIn('admin@example.com');
    const res = await app.request(`${BASE}/api/v1/plugins`, { headers: admin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plugins: [], broken: [], restartRequired: false });
  });

  it('uploads a plugin (off, with its permissions), then enables and disables it', async () => {
    const admin = await signIn('admin@example.com');
    const created = await upload(admin, pluginZip());
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      plugin: Json;
      plugins: Json[];
      restartRequired: boolean;
    };
    expect(body.plugin).toMatchObject({
      name: 'notes',
      version: '1.2.0',
      title: 'Notes',
      permissions: ['content:read', 'network'],
      enabled: false,
      hasMigrations: false,
    });
    expect(body.restartRequired).toBe(false);
    expect(await readdir(dir)).toEqual(['notes']);

    const on = await patch(admin, 'notes', { enabled: true });
    expect(on.status).toBe(200);
    const enabled = (await on.json()) as { plugin: Json; restartRequired: boolean };
    expect(enabled.plugin['enabled']).toBe(true);
    expect(enabled.restartRequired).toBe(true); // not loaded at boot yet

    loaded = ['notes']; // as after a restart
    const listed = (await (
      await app.request(`${BASE}/api/v1/plugins`, { headers: admin })
    ).json()) as Json;
    expect(listed['restartRequired']).toBe(false);

    const off = (await (await patch(admin, 'notes', { enabled: false })).json()) as Json;
    expect(off['restartRequired']).toBe(true);
    expect((off['plugin'] as Json)['enabled']).toBe(false);
  });

  it('rejects bad uploads with 400 and installs nothing', async () => {
    const admin = await signIn('admin@example.com');
    const bad = await upload(admin, new TextEncoder().encode('not a zip at all, sorry about that'));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_plugin' });
    const noManifest = await upload(admin, createTestZip([{ name: 'index.js', data: 'x' }]));
    expect(noManifest.status).toBe(400);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('refuses a second upload of the same plugin', async () => {
    const admin = await signIn('admin@example.com');
    expect((await upload(admin, pluginZip())).status).toBe(201);
    const again = await upload(admin, pluginZip());
    expect(again.status).toBe(400);
    expect(JSON.stringify(await again.json())).toContain('already installed');
  });

  it('checks content type and size of uploads', async () => {
    const admin = await signIn('admin@example.com');
    expect((await upload(admin, pluginZip(), 'text/plain')).status).toBe(415);
    const tooBig = await app.request(`${BASE}/api/v1/plugins`, {
      method: 'POST',
      headers: {
        'content-type': 'application/zip',
        'content-length': String(30 * 1024 * 1024),
        ...admin,
      },
      body: pluginZip(),
    });
    expect(tooBig.status).toBe(413);
  });

  it('validates PATCH input and unknown plugins', async () => {
    const admin = await signIn('admin@example.com');
    expect((await patch(admin, 'ghost', { enabled: true })).status).toBe(404);
    await upload(admin, pluginZip());
    expect((await patch(admin, 'notes', { enabled: 'yes' })).status).toBe(400);
    expect((await patch(admin, 'notes', {})).status).toBe(400);
    const notJson = await app.request(`${BASE}/api/v1/plugins/notes`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...admin },
      body: '{',
    });
    expect(notJson.status).toBe(400);
    const wrongType = await app.request(`${BASE}/api/v1/plugins/notes`, {
      method: 'PATCH',
      headers: { 'content-type': 'text/plain', ...admin },
      body: 'x',
    });
    expect(wrongType.status).toBe(415);
  });

  it('reports broken folders', async () => {
    const admin = await signIn('admin@example.com');
    await upload(admin, pluginZip());
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'oops'));
    await writeFile(join(dir, 'oops', 'plugin.json'), '{');
    const listed = (await (
      await app.request(`${BASE}/api/v1/plugins`, { headers: admin })
    ).json()) as {
      plugins: Json[];
      broken: Json[];
    };
    expect(listed.plugins.map((p) => p['name'])).toEqual(['notes']);
    expect(listed.broken).toEqual([{ folder: 'oops', message: 'plugin.json is not valid JSON' }]);
  });
});
