import {
  createApiTokensService,
  createCapabilities,
  createContactForm,
  createMemoryMailAdapter,
  createNodePress,
  createSessionsService,
  createUsersService,
  silentLogger,
  MIN_FILL_MS,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createContactSubmissionsStore,
  createDatabase,
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
let mail: ReturnType<typeof createMemoryMailAdapter>;
let now: number;

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
  now = 10_000_000;
  mail = createMemoryMailAdapter();
  const contact = createContactForm({
    store: createContactSubmissionsStore(database),
    secret: 's'.repeat(32),
    to: 'owner@example.com',
    mail,
    maxPerWindow: 3,
    now: () => now,
  });
  app = createApp(np, database, {
    auth: { users, sessions, apiTokens },
    contact: { contact, capabilities: createCapabilities(np.hooks), trustProxy: true },
  });
});

afterEach(async () => {
  await database.close();
});

const good = { name: 'Ada', email: 'ada@example.com', message: 'Hello there' };

async function token(): Promise<string> {
  const res = await app.request(`${BASE}/api/v1/contact/token`);
  const { token } = (await res.json()) as { token: string };
  now += MIN_FILL_MS + 1;
  return token;
}

function post(body: unknown, ip = '9.9.9.9', type = 'application/json') {
  return app.request(`${BASE}/api/v1/contact`, {
    method: 'POST',
    headers: { 'content-type': type, 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function signIn(email: string) {
  const res = await app.request(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

describe('POST /api/v1/contact', () => {
  it('accepts a message without signing in, stores it and emails it', async () => {
    const res = await post({ ...good, token: await token() });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: 'owner@example.com', replyTo: 'ada@example.com' });
  });

  it('rejects invalid fields with a message for each', async () => {
    const res = await post({ name: '', email: 'x', message: '', token: await token() });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; fields: Record<string, string> };
    expect(body.error).toBe('invalid_request');
    expect(Object.keys(body.fields).sort()).toEqual(['email', 'message', 'name']);
  });

  it('rejects a missing or too fresh token', async () => {
    expect(((await (await post(good)).json()) as { error: string }).error).toBe('bad_token');
    const fresh = (
      (await (await app.request(`${BASE}/api/v1/contact/token`)).json()) as { token: string }
    ).token;
    const res = await post({ ...good, token: fresh });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('bad_token');
    expect(mail.sent).toHaveLength(0);
  });

  it('pretends to accept a filled honeypot but stores and sends nothing', async () => {
    const res = await post({ ...good, website: 'http://spam.example', token: await token() });
    expect(res.status).toBe(201);
    expect(mail.sent).toHaveLength(0);
    const admin = await signIn('admin@example.com');
    const list = await app.request(`${BASE}/api/v1/contact/submissions`, { headers: admin });
    expect(((await list.json()) as { total: number }).total).toBe(0);
  });

  it('rate limits per sender with Retry-After', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await post({ ...good, token: await token() }, '1.1.1.1')).status).toBe(201);
    }
    const blocked = await post({ ...good, token: await token() }, '1.1.1.1');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await post({ ...good, token: await token() }, '2.2.2.2')).status).toBe(201);
  });

  it('refuses other content types, bad JSON and arrays', async () => {
    expect((await post('a=b', '9.9.9.9', 'text/plain')).status).toBe(415);
    expect((await post('{nope')).status).toBe(400);
    expect((await post('[]')).status).toBe(400);
    expect((await post('x'.repeat(20_000))).status).toBe(413);
  });
});

describe('GET /api/v1/contact/submissions', () => {
  it('needs a signed-in administrator', async () => {
    await post({ ...good, token: await token() });
    expect((await app.request(`${BASE}/api/v1/contact/submissions`)).status).toBe(401);
    const editor = await signIn('editor@example.com');
    expect(
      (await app.request(`${BASE}/api/v1/contact/submissions`, { headers: editor })).status,
    ).toBe(403);
    const admin = await signIn('admin@example.com');
    const res = await app.request(`${BASE}/api/v1/contact/submissions`, { headers: admin });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      submissions: Array<Record<string, unknown>>;
    };
    expect(body.total).toBe(1);
    expect(body.submissions[0]).toMatchObject({
      name: 'Ada',
      email: 'ada@example.com',
      message: 'Hello there',
      mailStatus: 'sent',
    });
    expect(body.submissions[0]).not.toHaveProperty('ipHash');
  });
});
