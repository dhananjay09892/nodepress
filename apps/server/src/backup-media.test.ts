import {
  createApiTokensService,
  createCapabilities,
  createContentService,
  createMediaService,
  createNodePress,
  createOptionsService,
  createSessionsService,
  createSettingsService,
  createTaxonomyService,
  createUsersService,
  exportSite,
  importSite,
  silentLogger,
  type ImageProcessor,
  type PasswordHasher,
  type StorageAdapter,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createContentMetaStore,
  createContentStore,
  createDatabase,
  createMediaStore,
  createOptionsStore,
  createSessionsStore,
  createTaxonomyStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { backupThemeSettings, ThemeSettingsService } from './theme-settings.js';

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

const processor: ImageProcessor = {
  inspect: async () => ({ width: 100, height: 50 }),
  resize: async (_data, o) => Buffer.from(`resized-${o.width}-${o.format}`),
};

function memoryStorage(): StorageAdapter {
  const files = new Map<string, Buffer>();
  return {
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
  await users.create({
    email: 'admin@example.com',
    password: PASSWORD,
    role: 'administrator',
    displayName: 'Admin',
  });
  const options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
  const content = createContentService({ store: createContentStore(database), hooks: np.hooks });
  const taxonomies = createTaxonomyService({
    store: createTaxonomyStore(database),
    hooks: np.hooks,
  });
  await taxonomies.refresh();
  const settings = createSettingsService({ options, isPublishedPage: async () => false });
  const storage = memoryStorage();
  const media = createMediaService({
    store: createMediaStore(database),
    storage,
    processor,
    hooks: np.hooks,
  });
  const meta = createContentMetaStore(database);
  const deps = {
    content,
    taxonomies,
    settings,
    meta,
    users,
    media: { service: media, storage },
    options,
    capabilities: createCapabilities(np.hooks),
  };
  const app = createApp(np, database, { auth: { users, sessions, apiTokens }, backup: deps });
  async function signIn() {
    const res = await app.request(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: PASSWORD }),
    });
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    return {
      cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!,
      'x-csrf-token': csrfToken,
    };
  }
  return { app, deps, content, media, options, meta, signIn };
}

describe('media zip through /api/v1/backup', () => {
  it('backs up media, restores it into a fresh site and points posts at the new files', async () => {
    const source = await makeSite();
    const image = await source.media.upload({ data: PNG, filename: 'cat.png', alt: 'A cat' });
    const post = await source.content.create(
      {
        type: 'post',
        title: 'With image',
        slug: 'with-image',
        status: 'published',
        body: [{ type: 'core/image', attrs: { mediaId: String(image.id), alt: 'A cat' } }] as never,
      },
      {},
    );
    await source.meta.setMeta(post.id, { featured_image: image.id });

    const admin = await source.signIn();
    const zip = await source.app.request(`${BASE}/api/v1/backup/media`, { headers: admin });
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('x-nodepress-media-omitted')).toBe('0');
    const zipBytes = Buffer.from(await zip.arrayBuffer());
    const json = await (
      await source.app.request(`${BASE}/api/v1/backup/export`, { headers: admin })
    ).text();

    const target = await makeSite();
    // An existing file makes the new ids differ from the old ones.
    await target.media.upload({ data: PNG, filename: 'older.png' });
    const targetAdmin = await target.signIn();
    const restored = await target.app.request(`${BASE}/api/v1/backup/media`, {
      method: 'POST',
      headers: { ...targetAdmin, 'content-type': 'application/zip' },
      body: zipBytes,
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ imported: 1, failed: [] });

    const imported = await target.app.request(`${BASE}/api/v1/backup/import`, {
      method: 'POST',
      headers: { ...targetAdmin, 'content-type': 'application/json' },
      body: json,
    });
    expect(imported.status).toBe(200);
    const [newPost] = await target.content.list({ type: 'post', status: ['published'] });
    const [newImage] = (await target.media.list()).filter((m) => m.alt === 'A cat');
    expect(newImage!.id).not.toBe(image.id);
    expect((await target.meta.getMeta(newPost!.id)).featured_image).toBe(newImage!.id);
    expect(JSON.stringify(newPost!.body)).toContain(`"mediaId":"${newImage!.id}"`);
    expect(JSON.stringify(newPost!.body)).not.toContain(`"mediaId":"${image.id}"`);
    // The map is used once: a second JSON import has no media to point at.
    expect(await target.options.get('backup_media_map')).toBeUndefined();
  });

  it('keeps leaving featured_image out when no media zip was restored first', async () => {
    const source = await makeSite();
    const image = await source.media.upload({ data: PNG, filename: 'cat.png' });
    const post = await source.content.create(
      { type: 'post', title: 'P', slug: 'p', status: 'published' },
      {},
    );
    await source.meta.setMeta(post.id, { featured_image: image.id });
    const json = await (
      await source.app.request(`${BASE}/api/v1/backup/export`, {
        headers: await source.signIn(),
      })
    ).text();
    const target = await makeSite();
    const res = await target.app.request(`${BASE}/api/v1/backup/import`, {
      method: 'POST',
      headers: { ...(await target.signIn()), 'content-type': 'application/json' },
      body: json,
    });
    expect(res.status).toBe(200);
    const [copy] = await target.content.list({ type: 'post', status: ['published'] });
    expect((await target.meta.getMeta(copy!.id)).featured_image).toBeUndefined();
  });

  it('refuses a wrong type, a file that is not a media backup, and non-administrators', async () => {
    const site = await makeSite();
    const admin = await site.signIn();
    const post = (body: string | Uint8Array, type: string) =>
      site.app.request(`${BASE}/api/v1/backup/media`, {
        method: 'POST',
        headers: { ...admin, 'content-type': type },
        body,
      });
    expect((await post('x', 'text/plain')).status).toBe(415);
    const bad = await post(new Uint8Array([1, 2, 3]), 'application/zip');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_media_backup' });
    expect((await site.app.request(`${BASE}/api/v1/backup/media`)).status).toBe(401);
  });

  it('reports media support on GET /', async () => {
    const site = await makeSite();
    const res = await site.app.request(`${BASE}/api/v1/backup`, { headers: await site.signIn() });
    expect(await res.json()).toMatchObject({ media: true });
  });
});

describe('theme settings in a backup', () => {
  const schema = {
    accent: { type: 'color', default: '#0b5cad' },
    layout: { type: 'select', options: ['blog', 'business'], default: 'blog' },
  };
  const theme = (name: string) => ({ active: { manifest: { name, settings: schema } } }) as never;

  async function settingsService() {
    const site = await makeSite();
    return { service: new ThemeSettingsService(site.options), site };
  }

  it('exports the saved values and restores them, with every value checked', async () => {
    const { service, site } = await settingsService();
    await service.update('demo', schema, { accent: '#aa0000', layout: 'business' });
    const adapter = backupThemeSettings(service, theme('demo'));
    const exported = await exportSite({ ...site.deps, themeSettings: adapter });
    expect(exported.themeSettings).toEqual({
      theme: 'demo',
      values: { accent: '#aa0000', layout: 'business' },
    });

    const target = await settingsService();
    const targetAdapter = backupThemeSettings(target.service, theme('demo'));
    const summary = await importSite(
      JSON.parse(JSON.stringify(exported)),
      { ...target.site.deps, themeSettings: targetAdapter },
      {},
    );
    expect(summary.themeSettings).toEqual({ applied: true });
    expect(await target.service.saved('demo', schema)).toEqual({
      accent: '#aa0000',
      layout: 'business',
    });
  });

  it('leaves the site alone for another theme, an invalid value or a site without the feature', async () => {
    const { service, site } = await settingsService();
    await service.update('demo', schema, { accent: '#aa0000' });
    const file = JSON.parse(
      JSON.stringify(
        await exportSite({
          ...site.deps,
          themeSettings: backupThemeSettings(service, theme('demo')),
        }),
      ),
    ) as { themeSettings: { theme: string; values: Record<string, unknown> } };

    const other = await settingsService();
    const wrongTheme = await importSite(
      file,
      { ...other.site.deps, themeSettings: backupThemeSettings(other.service, theme('other')) },
      {},
    );
    expect(wrongTheme.themeSettings?.applied).toBe(false);
    expect(wrongTheme.warnings.join('\n')).toMatch(/theme "demo".*"other" is active/);

    file.themeSettings.values = { accent: 'not-a-color' };
    const invalid = await importSite(
      file,
      { ...other.site.deps, themeSettings: backupThemeSettings(other.service, theme('demo')) },
      {},
    );
    expect(invalid.themeSettings).toMatchObject({ applied: false });
    expect(await other.service.saved('demo', schema)).toEqual({});

    const unsupported = await importSite(file, other.site.deps, {});
    expect(unsupported.warnings.join('\n')).toMatch(/Theme settings .* not restored/);
  });
});
