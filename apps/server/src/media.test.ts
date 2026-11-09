import {
  createApiTokensService,
  createCapabilities,
  createMediaService,
  createNodePress,
  createSessionsService,
  createUsersService,
  silentLogger,
  type ImageProcessor,
  type PasswordHasher,
  type StorageAdapter,
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

const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};

const PASSWORD = 'correct horse battery staple';
const BASE = 'http://localhost';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const processor: ImageProcessor = {
  inspect: async () => ({ width: 2000, height: 1000 }),
  resize: async (_data, o) => Buffer.from(`resized-${o.width}-${o.format}`),
};

function memoryStorage(): StorageAdapter & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async put(key, data) {
      files.set(key, Buffer.from(data));
    },
    async get(key) {
      return files.get(key);
    },
    async delete(key) {
      files.delete(key);
    },
  };
}

let database: DatabaseHandle;
let storage: ReturnType<typeof memoryStorage>;
let app: ReturnType<typeof createApp>;
let apiTokens: ReturnType<typeof createApiTokensService>;

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
    ['author@example.com', 'author'],
    ['author2@example.com', 'author'],
    ['sub@example.com', 'subscriber'],
  ] as const) {
    await users.create({ email, password: PASSWORD, role });
  }
  storage = memoryStorage();
  const service = createMediaService({
    store: createMediaStore(database),
    storage,
    processor,
    hooks: np.hooks,
    maxBytes: 2048,
  });
  app = createApp(np, database, {
    auth: { users, sessions, apiTokens },
    media: { service, storage, capabilities: createCapabilities(np.hooks) },
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

function uploadBody(data: Uint8Array, name = 'photo.png', type = 'image/png', alt?: string) {
  const form = new FormData();
  form.set('file', new File([data], name, { type }));
  if (alt !== undefined) form.set('alt', alt);
  return form;
}

async function upload(headers: Record<string, string>, body: FormData | string = uploadBody(PNG)) {
  return app.request(`${BASE}/api/v1/media`, { method: 'POST', headers, body });
}

describe('POST /api/v1/media', () => {
  it('stores an upload and returns URLs for the file and its variants', async () => {
    const session = await signIn('author@example.com');
    const res = await upload(session, uploadBody(PNG, 'My Photo.png', 'image/png', 'A photo'));
    expect(res.status).toBe(201);
    const { media } = (await res.json()) as {
      media: { url: string; variants: Record<string, string> } & Record<string, unknown>;
    };
    expect(media).toMatchObject({ mime: 'image/png', width: 2000, height: 1000, alt: 'A photo' });
    expect(media.url).toMatch(/^\/uploads\/\d{4}\/\d{2}\/my-photo-[0-9a-f]{8}\.png$/);
    expect(Object.keys(media.variants).sort()).toEqual(['large', 'medium', 'thumbnail', 'webp']);
    expect(storage.files.size).toBe(5);
    expect(JSON.stringify(media)).not.toContain('path');
  });

  it('works with a Bearer API token and no CSRF header', async () => {
    const admin = await signIn('admin@example.com');
    const me = (await (await app.request(`${BASE}/api/v1/auth/me`, { headers: admin })).json()) as {
      user: { id: number };
    };
    const created = await apiTokens.create(me.user.id, { name: 'ci' });
    const res = await upload({ authorization: `Bearer ${created.token}` });
    expect(res.status).toBe(201);
  });

  it('requires authentication and CSRF', async () => {
    expect((await upload({})).status).toBe(401);
    const session = await signIn('author@example.com');
    expect((await upload({ cookie: session.cookie })).status).toBe(403);
    expect(storage.files.size).toBe(0);
  });

  it('rejects cross-site origins', async () => {
    const session = await signIn('author@example.com');
    const res = await upload({ ...session, origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('forbids users without upload_files', async () => {
    const session = await signIn('sub@example.com');
    expect((await upload(session)).status).toBe(403);
    expect((await app.request(`${BASE}/api/v1/media`, { headers: session })).status).toBe(403);
    expect(storage.files.size).toBe(0);
  });

  it('blocks disallowed and mislabelled files', async () => {
    const session = await signIn('author@example.com');
    const svg = await upload(session, uploadBody(SVG, 'x.svg', 'image/svg+xml'));
    expect(svg.status).toBe(415);
    expect(((await svg.json()) as { error: string }).error).toBe('unsupported_type');
    const disguised = await upload(session, uploadBody(SVG, 'x.png', 'image/png'));
    expect(disguised.status).toBe(415);
    const mismatch = await upload(session, uploadBody(PNG, 'x.jpg', 'image/jpeg'));
    expect(mismatch.status).toBe(415);
    expect(((await mismatch.json()) as { error: string }).error).toBe('type_mismatch');
    expect(storage.files.size).toBe(0);
  });

  it('rejects files over the size limit with 413', async () => {
    const session = await signIn('author@example.com');
    const big = Buffer.concat([PNG, Buffer.alloc(3000)]);
    const res = await upload(session, uploadBody(big));
    expect(res.status).toBe(413);
    expect(storage.files.size).toBe(0);
  });

  it('rejects a body far beyond the limit before parsing it', async () => {
    const session = await signIn('author@example.com');
    const res = await upload(session, uploadBody(Buffer.alloc(200 * 1024)));
    expect(res.status).toBe(413);
  });

  it('rejects non-multipart and field-less requests', async () => {
    const session = await signIn('author@example.com');
    const json = await app.request(`${BASE}/api/v1/media`, {
      method: 'POST',
      headers: { ...session, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(json.status).toBe(415);
    const form = new FormData();
    form.set('other', 'x');
    expect((await upload(session, form)).status).toBe(400);
    const textFile = new FormData();
    textFile.set('file', 'not a file');
    expect((await upload(session, textFile)).status).toBe(400);
  });
});

describe('library routes', () => {
  async function uploadAs(email: string) {
    const session = await signIn(email);
    const res = await upload(session);
    const { media } = (await res.json()) as { media: { id: number } };
    return { session, id: media.id };
  }

  it('lists only own files for authors, everything for editors and admins', async () => {
    const a = await uploadAs('author@example.com');
    await uploadAs('author2@example.com');
    const own = (await (
      await app.request(`${BASE}/api/v1/media`, { headers: a.session })
    ).json()) as {
      media: { id: number }[];
    };
    expect(own.media.map((m) => m.id)).toEqual([a.id]);
    const admin = await signIn('admin@example.com');
    const all = (await (await app.request(`${BASE}/api/v1/media`, { headers: admin })).json()) as {
      media: unknown[];
    };
    expect(all.media).toHaveLength(2);
  });

  it('hides other authors files and lets admins manage them', async () => {
    const a = await uploadAs('author@example.com');
    const other = await signIn('author2@example.com');
    expect((await app.request(`${BASE}/api/v1/media/${a.id}`, { headers: other })).status).toBe(
      404,
    );
    expect(
      (await app.request(`${BASE}/api/v1/media/${a.id}`, { method: 'DELETE', headers: other }))
        .status,
    ).toBe(404);
    const admin = await signIn('admin@example.com');
    expect((await app.request(`${BASE}/api/v1/media/${a.id}`, { headers: admin })).status).toBe(
      200,
    );
  });

  it('updates alt text', async () => {
    const a = await uploadAs('author@example.com');
    const res = await app.request(`${BASE}/api/v1/media/${a.id}`, {
      method: 'PATCH',
      headers: { ...a.session, 'content-type': 'application/json' },
      body: JSON.stringify({ alt: 'New alt' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { media: { alt: string } }).media.alt).toBe('New alt');
    const bad = await app.request(`${BASE}/api/v1/media/${a.id}`, {
      method: 'PATCH',
      headers: { ...a.session, 'content-type': 'application/json' },
      body: JSON.stringify({ alt: 'x'.repeat(501) }),
    });
    expect(bad.status).toBe(400);
  });

  it('deletes the record and its files', async () => {
    const a = await uploadAs('author@example.com');
    expect(storage.files.size).toBe(5);
    const res = await app.request(`${BASE}/api/v1/media/${a.id}`, {
      method: 'DELETE',
      headers: a.session,
    });
    expect(res.status).toBe(204);
    expect(storage.files.size).toBe(0);
    expect((await app.request(`${BASE}/api/v1/media/${a.id}`, { headers: a.session })).status).toBe(
      404,
    );
    expect((await app.request(`${BASE}/api/v1/media/abc`, { headers: a.session })).status).toBe(
      404,
    );
  });
});

describe('GET /uploads/*', () => {
  it('serves stored files publicly with safe headers', async () => {
    const session = await signIn('author@example.com');
    const { media } = (await (await upload(session)).json()) as { media: { url: string } };
    const res = await app.request(`${BASE}${media.url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('answers 404 for missing files, traversal and unknown extensions', async () => {
    storage.files.set('uploads/2026/11/note.txt', Buffer.from('secret'));
    storage.files.set('secret.png', Buffer.from('outside'));
    for (const path of [
      '/uploads/2026/11/missing.png',
      '/uploads/2026/11/note.txt',
      '/uploads/%2e%2e/secret.png',
      '/uploads/%zz.png',
    ]) {
      expect((await app.request(`${BASE}${path}`)).status).toBe(404);
    }
  });
});
