import {
  createCapabilities,
  createNodePress,
  createSessionsService,
  createUsersService,
  silentLogger,
  type PasswordHasher,
} from '@nodepress/core';
import {
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
let ids: Record<string, number>;

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
  ids = {};
  for (const [name, role] of [
    ['admin', 'administrator'],
    ['editor', 'editor'],
    ['author', 'author'],
  ] as const) {
    const user = await users.create({
      email: `${name}@example.com`,
      password: PASSWORD,
      displayName: `${name[0]!.toUpperCase()}${name.slice(1)}`,
      role,
    });
    ids[name] = user.id;
  }
  app = createApp(np, database, {
    auth: { users, sessions },
    users: { service: users, capabilities: createCapabilities(np.hooks) },
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
  return app.request(`${BASE}/api/v1/users${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Json = Record<string, unknown>;

describe('GET /api/v1/users', () => {
  it('lists users by name with the roles, and never exposes a password hash', async () => {
    const res = await call('GET', '', await signIn('admin'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { users: Json[]; roles: string[] };
    expect(body.users.map((u) => u.displayName)).toEqual(['Admin', 'Author', 'Editor']);
    expect(body.roles).toEqual(['administrator', 'editor', 'author', 'contributor', 'subscriber']);
    expect(JSON.stringify(body)).not.toContain('fake$');
    expect(Object.keys(body.users[0]!).sort()).toEqual([
      'createdAt',
      'displayName',
      'email',
      'id',
      'role',
      'updatedAt',
    ]);
  });

  it('needs a sign-in and the list_users capability', async () => {
    expect((await call('GET', '', {})).status).toBe(401);
    expect((await call('GET', '', await signIn('editor'))).status).toBe(403);
    expect((await call('GET', `/${ids.admin}`, await signIn('author'))).status).toBe(403);
  });

  it('returns one user, or 404 for an unknown or malformed id', async () => {
    const admin = await signIn('admin');
    const res = await call('GET', `/${ids.editor}`, admin);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: Json }).user).toMatchObject({
      email: 'editor@example.com',
      role: 'editor',
    });
    expect((await call('GET', '/9999', admin)).status).toBe(404);
    expect((await call('GET', '/abc', admin)).status).toBe(404);
    expect((await call('GET', '/1e3', admin)).status).toBe(404);
  });
});

describe('PATCH /api/v1/users/:id', () => {
  it('changes a role, name and email', async () => {
    const admin = await signIn('admin');
    const res = await call('PATCH', `/${ids.author}`, admin, {
      role: 'editor',
      displayName: 'Ada',
      email: 'Ada@Example.com',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: Json }).user).toMatchObject({
      id: ids.author,
      role: 'editor',
      displayName: 'Ada',
      email: 'ada@example.com',
    });
    const again = await call('GET', `/${ids.author}`, admin);
    expect(((await again.json()) as { user: Json }).user.role).toBe('editor');
  });

  it('changes nothing when the body is empty', async () => {
    const res = await call('PATCH', `/${ids.author}`, await signIn('admin'), {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: Json }).user.role).toBe('author');
  });

  it('rejects an unknown role, a duplicate email and bad field types', async () => {
    const admin = await signIn('admin');
    const role = await call('PATCH', `/${ids.author}`, admin, { role: 'owner' });
    expect(role.status).toBe(400);
    expect(((await role.json()) as Json).error).toBe('invalid_request');

    const dup = await call('PATCH', `/${ids.author}`, admin, { email: 'editor@example.com' });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as Json).error).toBe('duplicate_email');

    expect((await call('PATCH', `/${ids.author}`, admin, { role: 5 })).status).toBe(400);
    expect((await call('PATCH', `/${ids.author}`, admin, { displayName: '  ' })).status).toBe(400);
    expect((await call('PATCH', `/${ids.author}`, admin, { email: 'nope' })).status).toBe(400);
  });

  it('does not let anyone change their own role, but allows other edits', async () => {
    const admin = await signIn('admin');
    const demote = await call('PATCH', `/${ids.admin}`, admin, { role: 'editor' });
    expect(demote.status).toBe(400);
    const same = await call('PATCH', `/${ids.admin}`, admin, { role: 'administrator' });
    expect(same.status).toBe(200);
    const rename = await call('PATCH', `/${ids.admin}`, admin, { displayName: 'Boss' });
    expect(rename.status).toBe(200);
  });

  it('lets one administrator demote another, and the demoted user loses access', async () => {
    const admin = await signIn('admin');
    expect((await call('PATCH', `/${ids.editor}`, admin, { role: 'administrator' })).status).toBe(
      200,
    );
    const second = await signIn('editor');
    expect((await call('GET', '', second)).status).toBe(200);
    expect((await call('PATCH', `/${ids.admin}`, second, { role: 'author' })).status).toBe(200);
    expect((await call('GET', '', admin)).status).toBe(403);
  });

  it('is forbidden without edit_users, and without a CSRF token for a session', async () => {
    expect(
      (await call('PATCH', `/${ids.author}`, await signIn('editor'), { displayName: 'x' })).status,
    ).toBe(403);
    const admin = await signIn('admin');
    const noCsrf = await call(
      'PATCH',
      `/${ids.author}`,
      { cookie: admin.cookie },
      { role: 'editor' },
    );
    expect(noCsrf.status).toBe(403);
    expect((await call('PATCH', `/${ids.author}`, {}, { role: 'editor' })).status).toBe(401);
  });

  it('answers 404, 415 and 400 for a missing user, wrong content type and bad JSON', async () => {
    const admin = await signIn('admin');
    expect((await call('PATCH', '/9999', admin, { displayName: 'x' })).status).toBe(404);
    expect((await call('PATCH', '/9999', admin, { role: 'editor' })).status).toBe(404);
    const text = await app.request(`${BASE}/api/v1/users/${ids.author}`, {
      method: 'PATCH',
      headers: { ...admin, 'content-type': 'text/plain' },
      body: 'role=editor',
    });
    expect(text.status).toBe(415);
    const bad = await app.request(`${BASE}/api/v1/users/${ids.author}`, {
      method: 'PATCH',
      headers: { ...admin, 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    expect((await call('PATCH', `/${ids.author}`, admin, [])).status).toBe(400);
  });
});

describe('POST /api/v1/users', () => {
  it('creates a user, who can then sign in', async () => {
    const admin = await signIn('admin');
    const res = await call('POST', '', admin, {
      email: 'New@Example.com',
      password: PASSWORD,
      displayName: 'Newbie',
      role: 'contributor',
    });
    expect(res.status).toBe(201);
    const { user } = (await res.json()) as { user: Json };
    expect(user).toMatchObject({ email: 'new@example.com', displayName: 'Newbie', role: 'contributor' });
    expect(JSON.stringify(user)).not.toContain('fake$');
    const login = await app.request(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: PASSWORD }),
    });
    expect(login.status).toBe(200);
  });

  it('defaults to the subscriber role', async () => {
    const res = await call('POST', '', await signIn('admin'), {
      email: 'sub@example.com',
      password: PASSWORD,
    });
    expect(((await res.json()) as { user: Json }).user.role).toBe('subscriber');
  });

  it('rejects missing fields, a duplicate email, a short password and an unknown role', async () => {
    const admin = await signIn('admin');
    expect((await call('POST', '', admin, { email: 'a@example.com' })).status).toBe(400);
    expect((await call('POST', '', admin, { password: PASSWORD })).status).toBe(400);
    expect((await call('POST', '', admin, { email: 5, password: PASSWORD })).status).toBe(400);
    const dup = await call('POST', '', admin, { email: 'editor@example.com', password: PASSWORD });
    expect(dup.status).toBe(409);
    expect((await call('POST', '', admin, { email: 'b@example.com', password: 'short' })).status).toBe(
      400,
    );
    const role = await call('POST', '', admin, {
      email: 'c@example.com',
      password: PASSWORD,
      role: 'owner',
    });
    expect(role.status).toBe(400);
  });

  it('is forbidden without create_users and unauthenticated without a session', async () => {
    const body = { email: 'd@example.com', password: PASSWORD };
    expect((await call('POST', '', await signIn('editor'), body)).status).toBe(403);
    expect((await call('POST', '', {}, body)).status).toBe(401);
  });
});
