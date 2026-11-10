import {
  createApiTokensService,
  createCapabilities,
  createJobQueue,
  createNodePress,
  createOptionsService,
  createSessionsService,
  createUsersService,
  createWebhookService,
  silentLogger,
  type FetchLike,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createDatabase,
  createJobsStore,
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
let apiTokens: ReturnType<typeof createApiTokensService>;
let jobs: ReturnType<typeof createJobQueue>;
let sent: Array<{ url: string; headers: Record<string, string> }>;

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
  apiTokens = createApiTokensService({
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
  jobs = createJobQueue({ store: createJobsStore(database), hooks: np.hooks });
  sent = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, headers: init.headers });
    return { status: 200 };
  };
  const webhooks = createWebhookService({
    options: createOptionsService({ store: createOptionsStore(database), hooks: np.hooks }),
    jobs,
    hooks: np.hooks,
    signingKey: 'k'.repeat(40),
    fetch,
    resolveHost: async () => ['93.184.216.34'],
  });
  webhooks.attach();
  app = createApp(np, database, {
    auth: { users, sessions, apiTokens },
    webhooks: { service: webhooks, capabilities: createCapabilities(np.hooks) },
  });
});

afterEach(async () => {
  await database.close();
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

function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return app.request(`${BASE}/api/v1/webhooks${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Json = Record<string, unknown>;

describe('/api/v1/webhooks', () => {
  it('creates a webhook, showing the secret once', async () => {
    const admin = await signIn('admin@example.com');
    const res = await call('POST', '', admin, {
      url: 'https://hooks.example.com/in',
      events: ['content.published'],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { webhook: Json; secret: string };
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.webhook).toMatchObject({ events: ['content.published'], active: true });

    const list = await (await call('GET', '', admin)).json();
    expect(JSON.stringify(list)).not.toContain(created.secret);
    expect(JSON.stringify(list)).toContain('hooks.example.com');
    const one = await call('GET', `/${String(created.webhook.id)}`, admin);
    expect(one.status).toBe(200);
    expect(JSON.stringify(await one.json())).not.toContain(created.secret);
  });

  it('updates, rotates, tests and deletes', async () => {
    const admin = await signIn('admin@example.com');
    const { webhook, secret } = (await (
      await call('POST', '', admin, { url: 'https://hooks.example.com/in' })
    ).json()) as { webhook: { id: string }; secret: string };
    const id = webhook.id;

    const patched = await call('PATCH', `/${id}`, admin, { active: false, description: 'CI' });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ webhook: { active: false, description: 'CI' } });

    const rotated = (await (await call('POST', `/${id}/rotate-secret`, admin)).json()) as {
      secret: string;
    };
    expect(rotated.secret).not.toBe(secret);

    const test = await call('POST', `/${id}/test`, admin);
    expect(test.status).toBe(202);
    await jobs.runDue();
    expect(sent.map((s) => s.headers['x-nodepress-event'])).toEqual(['webhook.ping']);

    expect((await call('DELETE', `/${id}`, admin)).status).toBe(204);
    expect((await call('DELETE', `/${id}`, admin)).status).toBe(404);
    expect((await call('GET', `/${id}`, admin)).status).toBe(404);
    expect((await call('POST', `/${id}/test`, admin)).status).toBe(404);
    expect((await call('PATCH', `/${id}`, admin, { active: true })).status).toBe(404);
  });

  it('rejects invalid input with 400', async () => {
    const admin = await signIn('admin@example.com');
    for (const body of [
      {},
      { url: 'http://127.0.0.1/x' },
      { url: 'https://hooks.example.com', events: ['nope'] },
    ]) {
      const res = await call('POST', '', admin, body);
      expect(res.status).toBe(400);
    }
    const bad = await app.request(`${BASE}/api/v1/webhooks`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    const wrongType = await app.request(`${BASE}/api/v1/webhooks`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(wrongType.status).toBe(415);
  });

  it('requires authentication, CSRF and manage_options', async () => {
    expect((await call('GET', '', {})).status).toBe(401);
    const admin = await signIn('admin@example.com');
    expect((await call('POST', '', { cookie: admin.cookie }, { url: 'https://a.example.com' })).status).toBe(403);
    const editor = await signIn('editor@example.com');
    expect((await call('GET', '', editor)).status).toBe(403);
    expect((await call('POST', '', editor, { url: 'https://a.example.com' })).status).toBe(403);
    const cross = await call('POST', '', { ...admin, origin: 'https://evil.example' }, { url: 'https://a.example.com' });
    expect(cross.status).toBe(403);
    expect(await (await call('GET', '', admin)).json()).toEqual({ webhooks: [] });
  });

  it('works with a Bearer API token', async () => {
    const admin = await signIn('admin@example.com');
    const me = (await (await app.request(`${BASE}/api/v1/auth/me`, { headers: admin })).json()) as {
      user: { id: number };
    };
    const { token } = await apiTokens.create(me.user.id, { name: 'ci' });
    const res = await call('POST', '', { authorization: `Bearer ${token}` }, { url: 'https://a.example.com/in' });
    expect(res.status).toBe(201);
  });
});
