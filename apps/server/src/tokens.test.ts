import {
  createApiTokensService,
  createNodePress,
  createSessionsService,
  createUsersService,
  silentLogger,
  type ApiTokensService,
  type PasswordHasher,
  type SessionsService,
  type UsersService,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createDatabase,
  createSessionsStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createAuth, type AuthEnv } from './auth.js';

/** Deterministic stand-in for Argon2 so tests are fast. */
const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};

const PASSWORD = 'correct horse battery staple';
const JSON_HEADERS = { 'content-type': 'application/json' };
const BASE = 'http://localhost';

let database: DatabaseHandle;
let users: UsersService;
let sessions: SessionsService;
let apiTokens: ApiTokensService;

beforeEach(async () => {
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  const np = createNodePress({ logger: silentLogger });
  users = createUsersService({
    store: createUsersStore(database),
    hooks: np.hooks,
    hasher: fakeHasher,
  });
  sessions = createSessionsService({
    store: createSessionsStore(database),
    users,
    hooks: np.hooks,
  });
  apiTokens = createApiTokensService({
    store: createApiTokensStore(database),
    users,
    hooks: np.hooks,
  });
  await users.create({ email: 'admin@example.com', password: PASSWORD, role: 'administrator' });
  await users.create({ email: 'other@example.com', password: PASSWORD, role: 'author' });
});

afterEach(async () => {
  await database.close();
});

function build() {
  const np = createNodePress({ logger: silentLogger });
  return createApp(np, database, { auth: { users, sessions, apiTokens } });
}

type Requester = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

/** Log in and return what a browser client would hold. */
async function signIn(app: Requester, email = 'admin@example.com') {
  const res = await app.request(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  return { cookie, csrfToken };
}

async function createToken(
  app: Requester,
  session: { cookie: string; csrfToken: string },
  body: Record<string, unknown> = { name: 'cli' },
) {
  const res = await app.request(`${BASE}/api/v1/tokens`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    body: JSON.stringify(body),
  });
  return res;
}

describe('/api/v1/tokens', () => {
  it('creates a token, shows the secret once, and lists it without the secret or hash', async () => {
    const app = build();
    const session = await signIn(app);
    const res = await createToken(app, session, { name: 'deploy' });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const created = (await res.json()) as {
      token: string;
      record: { id: number; name: string; expiresAt: string | null; lastUsedAt: string | null };
    };
    expect(created.token).toMatch(/^npt_[A-Za-z0-9_-]{43}$/);
    expect(created.record).toMatchObject({ name: 'deploy', expiresAt: null, lastUsedAt: null });

    const listRes = await app.request(`${BASE}/api/v1/tokens`, { headers: { cookie: session.cookie } });
    expect(listRes.status).toBe(200);
    const text = await listRes.text();
    expect(text).not.toContain(created.token);
    expect(text).not.toContain('tokenHash');
    expect(JSON.parse(text).tokens).toHaveLength(1);
  });

  it('stores only a hash of the secret', async () => {
    const app = build();
    const session = await signIn(app);
    const created = (await (await createToken(app, session)).json()) as { token: string };
    const rows = await createApiTokensStore(database).listByUser(
      (await users.findByEmail('admin@example.com'))!.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(created.token);
    expect(JSON.stringify(rows)).not.toContain(created.token);
  });

  it('requires a session, and CSRF for writes', async () => {
    const app = build();
    expect((await app.request(`${BASE}/api/v1/tokens`)).status).toBe(401);
    const session = await signIn(app);
    const noCsrf = await app.request(`${BASE}/api/v1/tokens`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie: session.cookie },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(noCsrf.status).toBe(403);
    const crossOrigin = await app.request(`${BASE}/api/v1/tokens`, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        cookie: session.cookie,
        'x-csrf-token': session.csrfToken,
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('does not let a token manage tokens', async () => {
    const app = build();
    const session = await signIn(app);
    const { token } = (await (await createToken(app, session)).json()) as { token: string };
    const headers = { ...JSON_HEADERS, authorization: `Bearer ${token}` };
    expect((await app.request(`${BASE}/api/v1/tokens`, { headers })).status).toBe(401);
    const create = await app.request(`${BASE}/api/v1/tokens`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'escalate' }),
    });
    expect(create.status).toBe(401);
  });

  it('validates input', async () => {
    const app = build();
    const session = await signIn(app);
    expect((await createToken(app, session, { name: '' })).status).toBe(400);
    expect((await createToken(app, session, {})).status).toBe(400);
    expect((await createToken(app, session, { name: 5 })).status).toBe(400);
    expect((await createToken(app, session, { name: 'a', expiresAt: 'soon' })).status).toBe(400);
    expect((await createToken(app, session, { name: 'a', expiresAt: 123 })).status).toBe(400);
    expect(
      (await createToken(app, session, { name: 'a', expiresAt: '2000-01-01T00:00:00Z' })).status,
    ).toBe(400);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const ok = await createToken(app, session, { name: 'a', expiresAt: future });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { record: { expiresAt: string } }).record.expiresAt).toBe(future);

    const form = await app.request(`${BASE}/api/v1/tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: session.cookie,
        'x-csrf-token': session.csrfToken,
      },
      body: 'name=x',
    });
    expect(form.status).toBe(415);
  });

  it('revokes a token, which then stops authenticating', async () => {
    const app = build();
    const session = await signIn(app);
    const created = (await (await createToken(app, session)).json()) as {
      token: string;
      record: { id: number };
    };
    const bearer = { authorization: `Bearer ${created.token}` };
    expect((await app.request(`${BASE}/api/v1/auth/me`, { headers: bearer })).status).toBe(200);

    const del = await app.request(`${BASE}/api/v1/tokens/${created.record.id}`, {
      method: 'DELETE',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    });
    expect(del.status).toBe(204);
    expect((await app.request(`${BASE}/api/v1/auth/me`, { headers: bearer })).status).toBe(401);

    const again = await app.request(`${BASE}/api/v1/tokens/${created.record.id}`, {
      method: 'DELETE',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    });
    expect(again.status).toBe(404);
  });

  it("cannot revoke someone else's token", async () => {
    const app = build();
    const admin = await signIn(app);
    const other = await signIn(app, 'other@example.com');
    const created = (await (await createToken(app, admin)).json()) as {
      token: string;
      record: { id: number };
    };
    const del = await app.request(`${BASE}/api/v1/tokens/${created.record.id}`, {
      method: 'DELETE',
      headers: { cookie: other.cookie, 'x-csrf-token': other.csrfToken },
    });
    expect(del.status).toBe(404);
    const bad = await app.request(`${BASE}/api/v1/tokens/abc`, {
      method: 'DELETE',
      headers: { cookie: other.cookie, 'x-csrf-token': other.csrfToken },
    });
    expect(bad.status).toBe(404);
    const list = await app.request(`${BASE}/api/v1/tokens`, { headers: { cookie: other.cookie } });
    expect(((await list.json()) as { tokens: unknown[] }).tokens).toHaveLength(0);
    expect(
      (
        await app.request(`${BASE}/api/v1/auth/me`, {
          headers: { authorization: `Bearer ${created.token}` },
        })
      ).status,
    ).toBe(200);
  });

  it('is not mounted when API tokens are not configured', async () => {
    const np = createNodePress({ logger: silentLogger });
    const app = createApp(np, database, { auth: { users, sessions } });
    expect((await app.request(`${BASE}/api/v1/tokens`)).status).toBe(404);
  });
});

describe('Bearer authentication', () => {
  async function tokenFor(app: Requester, email = 'admin@example.com') {
    const session = await signIn(app, email);
    const created = (await (await createToken(app, session)).json()) as { token: string };
    return created.token;
  }

  it('GET /api/v1/auth/me works with a token, and reports no CSRF token', async () => {
    const app = build();
    const token = await tokenFor(app);
    const res = await app.request(`${BASE}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string }; tokenId: number };
    expect(body.user.email).toBe('admin@example.com');
    expect(body).not.toHaveProperty('csrfToken');
  });

  it('answers 401 with a challenge for an invalid token', async () => {
    const app = build();
    for (const value of ['Bearer', 'Bearer nope', `Bearer npt_${'a'.repeat(43)}`]) {
      const res = await app.request(`${BASE}/api/v1/auth/me`, { headers: { authorization: value } });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    }
  });

  it('an invalid token does not fall back to a valid cookie', async () => {
    const app = build();
    const { cookie } = await signIn(app);
    const res = await app.request(`${BASE}/api/v1/auth/me`, {
      headers: { cookie, authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('is rejected when API tokens are not configured', async () => {
    const np = createNodePress({ logger: silentLogger });
    const app = createApp(np, database, { auth: { users, sessions } });
    const res = await app.request(`${BASE}/api/v1/auth/me`, {
      headers: { authorization: `Bearer npt_${'a'.repeat(43)}` },
    });
    expect(res.status).toBe(401);
  });

  it('stops working when its user is deleted', async () => {
    const app = build();
    const token = await tokenFor(app, 'other@example.com');
    const victim = await users.findByEmail('other@example.com');
    await users.delete(victim!.id);
    const res = await app.request(`${BASE}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('records lastUsedAt', async () => {
    const app = build();
    const session = await signIn(app);
    const token = ((await (await createToken(app, session)).json()) as { token: string }).token;
    await app.request(`${BASE}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    const list = await app.request(`${BASE}/api/v1/tokens`, { headers: { cookie: session.cookie } });
    const { tokens } = (await list.json()) as { tokens: { lastUsedAt: string | null }[] };
    expect(tokens[0]!.lastUsedAt).not.toBeNull();
  });

  describe('authenticate middleware', () => {
    function protectedApp() {
      const auth = createAuth({ users, sessions, apiTokens });
      const app = new Hono<AuthEnv>();
      app.use('/api/v1/*', auth.originGuard);
      app.get('/api/v1/thing', auth.authenticate, (c) =>
        c.json({ via: c.get('principal')!.via, email: c.get('principal')!.user.email }),
      );
      app.post('/api/v1/thing', auth.authenticate, (c) => c.json({ via: c.get('principal')!.via }));
      app.route('/api/v1/auth', auth.routes);
      app.route('/api/v1/tokens', auth.tokenRoutes);
      return app;
    }

    it('answers 401 to anonymous requests', async () => {
      const app = protectedApp();
      const res = await app.request(`${BASE}/api/v1/thing`);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    });

    it('accepts a token for reads and writes without CSRF', async () => {
      const app = protectedApp();
      const token = await tokenFor(app);
      const headers = { authorization: `Bearer ${token}` };
      const read = await app.request(`${BASE}/api/v1/thing`, { headers });
      expect(await read.json()).toEqual({ via: 'token', email: 'admin@example.com' });
      const write = await app.request(`${BASE}/api/v1/thing`, { method: 'POST', headers });
      expect(write.status).toBe(200);
    });

    it('accepts the Bearer scheme case-insensitively', async () => {
      const app = protectedApp();
      const token = await tokenFor(app);
      const res = await app.request(`${BASE}/api/v1/thing`, {
        headers: { authorization: `bearer ${token}` },
      });
      expect(res.status).toBe(200);
    });

    it('still enforces CSRF for cookie sessions', async () => {
      const app = protectedApp();
      const session = await signIn(app);
      const read = await app.request(`${BASE}/api/v1/thing`, { headers: { cookie: session.cookie } });
      expect(await read.json()).toMatchObject({ via: 'session' });
      const noCsrf = await app.request(`${BASE}/api/v1/thing`, {
        method: 'POST',
        headers: { cookie: session.cookie },
      });
      expect(noCsrf.status).toBe(403);
      const ok = await app.request(`${BASE}/api/v1/thing`, {
        method: 'POST',
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
      });
      expect(ok.status).toBe(200);
    });

    it('rejects a revoked or expired token', async () => {
      const app = protectedApp();
      const session = await signIn(app);
      const created = (await (await createToken(app, session)).json()) as {
        token: string;
        record: { id: number };
      };
      const headers = { authorization: `Bearer ${created.token}` };
      expect((await app.request(`${BASE}/api/v1/thing`, { headers })).status).toBe(200);
      await app.request(`${BASE}/api/v1/tokens/${created.record.id}`, {
        method: 'DELETE',
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
      });
      expect((await app.request(`${BASE}/api/v1/thing`, { headers })).status).toBe(401);
    });
  });
});
