import {
  createNodePress,
  createSessionsService,
  createUsersService,
  RateLimiter,
  silentLogger,
  type PasswordHasher,
  type SessionsService,
  type UsersService,
} from '@nodepress/core';
import {
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

let database: DatabaseHandle;
let users: UsersService;
let sessions: SessionsService;

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
  await users.create({ email: 'admin@example.com', password: PASSWORD, role: 'administrator' });
  await users.create({ email: 'other@example.com', password: PASSWORD, role: 'author' });
});

afterEach(async () => {
  await database.close();
});

function build(extra: { secureCookies?: boolean } = {}) {
  const np = createNodePress({ logger: silentLogger });
  return createApp(np, database, { auth: { users, sessions, ...extra } });
}

type Requester = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

function login(app: Requester, email: string, password: string, headers: Record<string, string> = {}) {
  return app.request('http://localhost/api/v1/auth/login', {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify({ email, password }),
  });
}

/** `name=value` of the first Set-Cookie header. */
function cookiePair(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

describe('POST /api/v1/auth/login', () => {
  it('logs in and sets a hardened session cookie', async () => {
    const res = await login(build(), 'Admin@Example.com', PASSWORD);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown>; csrfToken: string };
    expect(body.user).toMatchObject({ email: 'admin@example.com', role: 'administrator' });
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.csrfToken.length).toBeGreaterThan(20);

    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^__Host-np_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Domain');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('can issue a non-Secure cookie for plain-HTTP development', async () => {
    const res = await login(build({ secureCookies: false }), 'admin@example.com', PASSWORD);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^np_session=/);
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
  });

  it('rejects a wrong password and an unknown email with the same answer', async () => {
    const app = build();
    const wrong = await login(app, 'admin@example.com', 'not the password');
    const unknown = await login(app, 'nobody@example.com', PASSWORD);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(wrong.headers.get('set-cookie')).toBeNull();
  });

  it('rejects malformed requests', async () => {
    const app = build();
    const url = 'http://localhost/api/v1/auth/login';
    const form = await app.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a%40b.co&password=x',
    });
    expect(form.status).toBe(415);
    const bad = await app.request(url, { method: 'POST', headers: JSON_HEADERS, body: '{nope' });
    expect(bad.status).toBe(400);
    const missing = await app.request(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'admin@example.com' }),
    });
    expect(missing.status).toBe(400);
    const huge = await app.request(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(20_000) }),
    });
    expect(huge.status).toBe(413);
  });

  it('rejects a login sent from another origin', async () => {
    const res = await login(build(), 'admin@example.com', PASSWORD, {
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    const same = await login(build(), 'admin@example.com', PASSWORD, {
      origin: 'http://localhost',
    });
    expect(same.status).toBe(200);
  });

  it('rate limits repeated failures per email, even for the right password', async () => {
    const app = build();
    for (let i = 0; i < 5; i++) {
      expect((await login(app, 'admin@example.com', `wrong ${i}`)).status).toBe(401);
    }
    const blocked = await login(app, 'admin@example.com', PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.headers.get('set-cookie')).toBeNull();
    // Another account is unaffected (the per-address limit is higher).
    expect((await login(app, 'other@example.com', PASSWORD)).status).toBe(200);
  });

  it('rate limits per client address across emails', async () => {
    const np = createNodePress({ logger: silentLogger });
    const app = createApp(np, database, {
      auth: {
        users,
        sessions,
        loginLimitByIp: new RateLimiter({ max: 3, windowMs: 60_000 }),
      },
    });
    for (let i = 0; i < 3; i++) {
      expect((await login(app, `user${i}@example.com`, 'x')).status).toBe(401);
    }
    expect((await login(app, 'admin@example.com', PASSWORD)).status).toBe(429);
  });

  it('a successful login clears the failure count for that email', async () => {
    const app = build();
    for (let i = 0; i < 4; i++) await login(app, 'admin@example.com', 'wrong');
    expect((await login(app, 'admin@example.com', PASSWORD)).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await login(app, 'admin@example.com', 'wrong')).status).toBe(401);
    }
  });

  it('replaces an existing session instead of reusing it', async () => {
    const app = build();
    const first = cookiePair(await login(app, 'admin@example.com', PASSWORD));
    const second = await login(app, 'admin@example.com', PASSWORD, { cookie: first });
    expect(cookiePair(second)).not.toBe(first);
    const me = await app.request('http://localhost/api/v1/auth/me', { headers: { cookie: first } });
    expect(me.status).toBe(401);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns the signed-in user and CSRF token', async () => {
    const app = build();
    const loginRes = await login(app, 'admin@example.com', PASSWORD);
    const { csrfToken } = (await loginRes.json()) as { csrfToken: string };
    const res = await app.request('http://localhost/api/v1/auth/me', {
      headers: { cookie: cookiePair(loginRes) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string }; csrfToken: string };
    expect(body.user.email).toBe('admin@example.com');
    expect(body.csrfToken).toBe(csrfToken);
  });

  it('is 401 without a cookie, with a forged one, and after the user is deleted', async () => {
    const app = build();
    expect((await app.request('http://localhost/api/v1/auth/me')).status).toBe(401);
    const forged = await app.request('http://localhost/api/v1/auth/me', {
      headers: { cookie: `__Host-np_session=${'a'.repeat(43)}` },
    });
    expect(forged.status).toBe(401);

    const other = await login(app, 'other@example.com', PASSWORD);
    const victim = await users.findByEmail('other@example.com');
    await users.delete(victim!.id);
    const gone = await app.request('http://localhost/api/v1/auth/me', {
      headers: { cookie: cookiePair(other) },
    });
    expect(gone.status).toBe(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('rejects a cookie-authenticated logout without the CSRF token', async () => {
    const app = build();
    const cookie = cookiePair(await login(app, 'admin@example.com', PASSWORD));
    const noToken = await app.request('http://localhost/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie },
    });
    expect(noToken.status).toBe(403);
    const wrong = await app.request('http://localhost/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': 'x'.repeat(43) },
    });
    expect(wrong.status).toBe(403);
    const me = await app.request('http://localhost/api/v1/auth/me', { headers: { cookie } });
    expect(me.status).toBe(200);
  });

  it('ends the session and clears the cookie', async () => {
    const app = build();
    const loginRes = await login(app, 'admin@example.com', PASSWORD);
    const { csrfToken } = (await loginRes.json()) as { csrfToken: string };
    const cookie = cookiePair(loginRes);
    const res = await app.request('http://localhost/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(res.status).toBe(204);
    const cleared = res.headers.get('set-cookie')!;
    expect(cleared).toMatch(/^__Host-np_session=;/);
    expect(cleared).toMatch(/Max-Age=0/i);
    const me = await app.request('http://localhost/api/v1/auth/me', { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  it('is a harmless no-op without a session', async () => {
    const res = await build().request('http://localhost/api/v1/auth/logout', { method: 'POST' });
    expect(res.status).toBe(204);
  });

  it('rejects a logout sent from another origin', async () => {
    const res = await build().request('http://localhost/api/v1/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});

describe('requireAuth middleware', () => {
  function protectedApp() {
    const auth = createAuth({ users, sessions });
    const app = new Hono<AuthEnv>();
    app.use('/api/v1/*', auth.originGuard, auth.loadSession);
    app.get('/api/v1/thing', auth.requireAuth, (c) => c.json({ ok: true }));
    app.post('/api/v1/thing', auth.requireAuth, (c) => c.json({ ok: true }));
    app.route('/api/v1/auth', auth.routes);
    return app;
  }

  it('answers 401 to anonymous requests', async () => {
    const app = protectedApp();
    expect((await app.request('http://localhost/api/v1/thing')).status).toBe(401);
    expect((await app.request('http://localhost/api/v1/thing', { method: 'POST' })).status).toBe(
      401,
    );
  });

  it('lets reads through, and writes only with a valid CSRF token', async () => {
    const app = protectedApp();
    const loginRes = await login(app, 'admin@example.com', PASSWORD);
    const { csrfToken } = (await loginRes.json()) as { csrfToken: string };
    const cookie = cookiePair(loginRes);

    expect((await app.request('http://localhost/api/v1/thing', { headers: { cookie } })).status).toBe(
      200,
    );
    const noToken = await app.request('http://localhost/api/v1/thing', {
      method: 'POST',
      headers: { cookie },
    });
    expect(noToken.status).toBe(403);
    expect(await noToken.json()).toEqual({ error: 'csrf_failed' });
    const ok = await app.request('http://localhost/api/v1/thing', {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(ok.status).toBe(200);
  });

  it('does not accept the CSRF token of another session', async () => {
    const app = protectedApp();
    const a = await login(app, 'admin@example.com', PASSWORD);
    const b = await login(app, 'other@example.com', PASSWORD);
    const { csrfToken: tokenB } = (await b.json()) as { csrfToken: string };
    const res = await app.request('http://localhost/api/v1/thing', {
      method: 'POST',
      headers: { cookie: cookiePair(a), 'x-csrf-token': tokenB },
    });
    expect(res.status).toBe(403);
  });
});
