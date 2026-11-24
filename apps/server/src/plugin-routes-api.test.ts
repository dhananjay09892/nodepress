import {
  createApiTokensService,
  createCapabilities,
  createNodePress,
  createSessionsService,
  createUsersService,
  PluginRouteRegistry,
  silentLogger,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createDatabase,
  createSessionsStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { MAX_PLUGIN_BODY_BYTES } from './plugin-routes-api.js';

const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};
const PASSWORD = 'correct horse battery staple';
const BASE = 'http://localhost';

const open: DatabaseHandle[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function makeSite() {
  const database = createDatabase({ url: ':memory:' });
  open.push(database);
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
  for (const [name, role] of [
    ['admin', 'administrator'],
    ['editor', 'editor'],
  ] as const) {
    await users.create({ email: `${name}@example.com`, password: PASSWORD, role });
  }
  const registry = new PluginRouteRegistry();
  const ran: string[] = [];
  registry.add('shop', {
    method: 'GET',
    path: '/hello',
    capability: 'public',
    handler: () => ({ json: { hi: true } }),
  });
  registry.add('shop', {
    method: 'GET',
    path: '/secret',
    capability: 'manage_options',
    handler: ({ user }) => {
      ran.push('secret');
      return { json: { for: user?.email } };
    },
  });
  registry.add('shop', {
    method: 'POST',
    path: '/items/:id',
    capability: 'edit_posts',
    handler: async (request) => {
      ran.push('items');
      return {
        status: 201,
        json: { id: request.params['id'], body: await request.json(), q: request.query },
      };
    },
  });
  registry.add('shop', {
    method: 'GET',
    path: '/boom',
    capability: 'public',
    handler: () => {
      throw new Error('secret internal detail');
    },
  });
  registry.add('shop', {
    method: 'GET',
    path: '/slow',
    capability: 'public',
    handler: () => new Promise(() => {}),
  });
  registry.add('shop', {
    method: 'GET',
    path: '/headers',
    capability: 'public',
    handler: () => ({
      status: 999,
      text: 'plain',
      headers: {
        'Set-Cookie': 'np_session=stolen',
        'Content-Security-Policy': 'default-src *',
        'X-Custom': 'ok',
        'X-Bad': 'a\r\nInjected: 1',
      },
    }),
  });
  registry.add('shop', {
    method: 'GET',
    path: '/image',
    capability: 'public',
    handler: () => ({
      bytes: Uint8Array.from([71, 73, 70]),
      headers: { 'Content-Type': 'image/gif' },
    }),
  });
  registry.add('shop', {
    method: 'GET',
    path: '/script.js',
    capability: 'public',
    handler: () => ({ text: 'ok();', headers: { 'Content-Type': 'text/javascript' } }),
  });
  registry.add('shop', {
    method: 'GET',
    path: '/who',
    capability: 'public',
    handler: ({ clientIp, headers }) => ({ json: { clientIp, host: headers['host'] } }),
  });
  const app = createApp(np, database, {
    auth: { users, sessions, apiTokens },
    pluginRoutes: {
      registry,
      trustProxy: true,
      capabilities: createCapabilities(np.hooks),
      timeoutMs: 50,
    },
  });
  async function signIn(name: string) {
    const res = await app.request(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${name}@example.com`, password: PASSWORD }),
    });
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    return {
      cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!,
      'x-csrf-token': csrfToken,
    };
  }
  return { app, registry, ran, signIn };
}

const url = (path: string) => `${BASE}/api/v1/plugins/shop${path}`;

describe('routes added by plugins', () => {
  it('serves a public route without credentials, uncached', async () => {
    const { app } = await makeSite();
    const res = await app.request(url('/hello'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hi: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 401 and 403 before the handler runs, and 200 for a user with the capability', async () => {
    const { app, ran, signIn } = await makeSite();
    expect((await app.request(url('/secret'))).status).toBe(401);
    const editor = await signIn('editor');
    expect((await app.request(url('/secret'), { headers: editor })).status).toBe(403);
    expect(ran).toEqual([]);
    const admin = await signIn('admin');
    const ok = await app.request(url('/secret'), { headers: admin });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ for: 'admin@example.com' });
    expect(ran).toEqual(['secret']);
  });

  it('needs the CSRF token for a session write and passes params, query and the JSON body', async () => {
    const { app, ran, signIn } = await makeSite();
    const editor = await signIn('editor');
    const post = (headers: Record<string, string>, body = '{"n":1}') =>
      app.request(url('/items/42?x=1&x=2'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
    const noCsrf = await post({ cookie: editor.cookie });
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toEqual({ error: 'csrf_failed' });
    expect(ran).toEqual([]);

    const ok = await post(editor);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ id: '42', body: { n: 1 }, q: { x: '1' } });

    const bad = await post(editor, '{not json');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_request' });
    const big = await post(editor, JSON.stringify({ pad: 'x'.repeat(MAX_PLUGIN_BODY_BYTES) }));
    expect(big.status).toBe(400);
  });

  it('turns a throwing handler into a 500 without details and keeps other routes working', async () => {
    const { app } = await makeSite();
    const res = await app.request(url('/boom'));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'plugin_error' });
    expect(text).not.toContain('secret internal detail');
    expect((await app.request(url('/hello'))).status).toBe(200);
  });

  it('answers 504 for a handler that never finishes', async () => {
    const { app } = await makeSite();
    const res = await app.request(url('/slow'));
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: 'plugin_timeout' });
  });

  it('does not let a plugin set cookies or security headers, or break the status line', async () => {
    const { app } = await makeSite();
    const res = await app.request(url('/headers'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('plain');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-security-policy')).not.toBe('default-src *');
    expect(res.headers.get('x-custom')).toBe('ok');
    expect(res.headers.get('x-bad')).toBeNull();
  });

  it('falls through for unknown paths and methods, and stops serving a removed plugin', async () => {
    const { app, registry } = await makeSite();
    expect((await app.request(url('/nope'))).status).toBe(404);
    expect((await app.request(url('/hello'), { method: 'DELETE' })).status).toBe(404);
    expect((await app.request(`${BASE}/api/v1/plugins/other/hello`)).status).toBe(404);
    registry.removeAllFromSource('shop');
    expect((await app.request(url('/hello'))).status).toBe(404);
  });

  it('lets a plugin answer with bytes or a script and choose the content type', async () => {
    const { app } = await makeSite();
    const image = await app.request(url('/image'));
    expect(image.headers.get('content-type')).toBe('image/gif');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(Uint8Array.from([71, 73, 70]));
    const script = await app.request(url('/script.js'));
    expect(script.headers.get('content-type')).toBe('text/javascript');
    expect(await script.text()).toBe('ok();');
  });

  it('tells the handler the client address (from the proxy header when trusted) and host', async () => {
    const { app } = await makeSite();
    const res = await app.request(url('/who'), { headers: { 'x-forwarded-for': '198.51.100.9' } });
    expect(await res.json()).toEqual({ clientIp: '198.51.100.9', host: 'localhost' });
  });
});
