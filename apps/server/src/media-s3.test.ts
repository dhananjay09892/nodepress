import {
  createApiTokensService,
  createCapabilities,
  createMediaService,
  createNodePress,
  createS3Storage,
  createSessionsService,
  createUsersService,
  silentLogger,
  type ImageProcessor,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createDatabase,
  createMediaStore,
  createSessionsStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const hasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};
const PASSWORD = 'correct horse battery staple';
const BASE = 'http://localhost';
const SECRET = 'test-secret-access-key';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);
const processor: ImageProcessor = {
  inspect: async () => ({ width: 2000, height: 1000 }),
  resize: async (_data, o) => Buffer.from(`resized-${o.width}-${o.format}`),
};

let database: DatabaseHandle;
let objects: Map<string, Buffer>;
let authorizations: string[];

/** A tiny in-memory S3: path-style keys, PUT/GET/DELETE. */
const fakeS3 = (async (url: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(url)).pathname;
  authorizations.push(String((init?.headers as Record<string, string>).authorization));
  if (init?.method === 'PUT') {
    objects.set(path, Buffer.from(init.body as Uint8Array));
    return new Response(null, { status: 200 });
  }
  if (init?.method === 'DELETE') {
    objects.delete(path);
    return new Response(null, { status: 204 });
  }
  const data = objects.get(path);
  return data ? new Response(new Uint8Array(data)) : new Response('', { status: 404 });
}) as typeof fetch;

async function makeApp(publicUrl?: string) {
  const np = createNodePress({ logger: silentLogger });
  const users = createUsersService({ store: createUsersStore(database), hooks: np.hooks, hasher });
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
  await users.create({ email: 'author@example.com', password: PASSWORD, role: 'author' });
  const storage = createS3Storage({
    bucket: 'media',
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: SECRET,
    endpoint: 'http://minio:9000',
    fetch: fakeS3,
  });
  const service = createMediaService({
    store: createMediaStore(database),
    storage,
    processor,
    hooks: np.hooks,
  });
  return createApp(np, database, {
    auth: { users, sessions, apiTokens },
    media: {
      service,
      storage,
      capabilities: createCapabilities(np.hooks),
      ...(publicUrl ? { publicUrl } : {}),
    },
  });
}

async function uploadPng(app: Awaited<ReturnType<typeof makeApp>>) {
  const login = await app.request(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'author@example.com', password: PASSWORD }),
  });
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const headers = {
    cookie: (login.headers.get('set-cookie') ?? '').split(';')[0]!,
    'x-csrf-token': csrfToken,
  };
  const form = new FormData();
  form.set('file', new File([PNG], 'photo.png', { type: 'image/png' }));
  const res = await app.request(`${BASE}/api/v1/media`, { method: 'POST', headers, body: form });
  expect(res.status).toBe(201);
  return (
    (await res.json()) as { media: { id: number; url: string; variants: Record<string, string> } }
  ).media;
}

beforeEach(async () => {
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  objects = new Map();
  authorizations = [];
});
afterEach(async () => {
  await database.close();
});

describe('media on S3-compatible storage', () => {
  it('stores the original and variants in the bucket and serves them through /uploads', async () => {
    const app = await makeApp();
    const media = await uploadPng(app);
    expect(objects.size).toBe(5);
    expect([...objects.keys()].every((k) => k.startsWith('/media/uploads/'))).toBe(true);
    expect(media.url).toMatch(/^\/uploads\//);

    const res = await app.request(`${BASE}${media.url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await app.request(`${BASE}/uploads/2026/01/missing-1a2b3c4d.png`)).status).toBe(404);
  });

  it('points file URLs at S3_PUBLIC_URL when it is set', async () => {
    const app = await makeApp('https://cdn.example.com/');
    const media = await uploadPng(app);
    expect(media.url).toMatch(/^https:\/\/cdn\.example\.com\/uploads\/\d{4}\/\d{2}\/photo-/);
    for (const url of Object.values(media.variants))
      expect(url).toMatch(/^https:\/\/cdn\.example\.com\/uploads\//);
  });

  it('never exposes the secret key in API answers or request headers', async () => {
    const app = await makeApp();
    const media = await uploadPng(app);
    expect(JSON.stringify(media)).not.toContain(SECRET);
    expect(authorizations.length).toBeGreaterThan(0);
    expect(authorizations.join('\n')).not.toContain(SECRET);
  });
});
