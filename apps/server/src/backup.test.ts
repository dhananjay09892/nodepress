import {
  createApiTokensService,
  createCapabilities,
  createContentService,
  createNodePress,
  createOptionsService,
  createSessionsService,
  createSettingsService,
  createTaxonomyService,
  createUsersService,
  exportSite,
  importSite,
  silentLogger,
  type BackupDeps,
  type PasswordHasher,
  type SiteExport,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createContentMetaStore,
  createContentStore,
  createDatabase,
  createOptionsStore,
  createSessionsStore,
  createTaxonomyStore,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

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
  const admin = await users.create({
    email: 'admin@example.com',
    password: PASSWORD,
    role: 'administrator',
    displayName: 'Admin',
  });
  const editor = await users.create({
    email: 'editor@example.com',
    password: PASSWORD,
    role: 'editor',
  });
  const options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
  const content = createContentService({ store: createContentStore(database), hooks: np.hooks });
  const taxonomies = createTaxonomyService({
    store: createTaxonomyStore(database),
    hooks: np.hooks,
  });
  await taxonomies.refresh();
  const settings = createSettingsService({
    options,
    isPublishedPage: async (id) => {
      const page = await content.get(id);
      return page?.type === 'page' && page.status === 'published';
    },
  });
  const deps: BackupDeps = {
    content,
    taxonomies,
    settings,
    meta: createContentMetaStore(database),
    users,
  };
  const app = createApp(np, database, {
    auth: { users, sessions, apiTokens },
    backup: { ...deps, capabilities: createCapabilities(np.hooks) },
  });
  return { database, deps, content, taxonomies, settings, admin, editor, app, users };
}

type Site = Awaited<ReturnType<typeof makeSite>>;

async function seed(site: Site) {
  const { content, taxonomies, deps } = site;
  const travel = await taxonomies.createTerm({ taxonomy: 'category', name: 'Travel' });
  const italy = await taxonomies.createTerm({
    taxonomy: 'category',
    name: 'Italy',
    parentId: travel.id,
  });
  const tag = await taxonomies.createTerm({ taxonomy: 'tag', name: 'Rome' });
  const about = await content.create(
    { type: 'page', title: 'About', slug: 'about', status: 'published' },
    {},
  );
  const team = await content.create(
    { type: 'page', title: 'Team', slug: 'team', status: 'published', parentId: about.id },
    {},
  );
  const post = await content.create(
    {
      type: 'post',
      title: 'Hello Rome',
      slug: 'hello-rome',
      status: 'published',
      excerpt: 'Ciao',
      authorId: site.editor.id,
      publishedAt: new Date('2024-05-01T10:00:00Z'),
      body: [{ type: 'core/paragraph', content: [{ text: 'Ciao!' }] }] as never,
    },
    {},
  );
  await content.create(
    { type: 'post', title: 'Draft idea', slug: 'draft-idea', status: 'draft' },
    {},
  );
  const trashed = await content.create(
    { type: 'post', title: 'Old', slug: 'old', status: 'draft' },
    {},
  );
  await content.update(trashed.id, { status: 'trash' }, {});
  await deps.meta!.setMeta(post.id, { subtitle: 'A trip', featured_image: 5 });
  await taxonomies.setContentTerms(post.id, 'category', [italy.id]);
  await taxonomies.setContentTerms(post.id, 'tag', [tag.id]);
  await site.settings.update({
    site_title: 'Old & Gold',
    tagline: 'Since 1999',
    front_page_id: about.id,
    posts_per_page: 5,
  });
  return { about, team, post };
}

describe('exportSite', () => {
  it('exports content of every status with fields, terms, settings and author names, and no secrets', async () => {
    const site = await makeSite();
    await seed(site);
    const data = await exportSite({ ...site.deps, now: () => new Date('2026-11-20T10:00:00Z') });
    expect(data).toMatchObject({
      format: 'nodepress-export',
      version: 1,
      exportedAt: '2026-11-20T10:00:00.000Z',
    });
    expect(data.content.map((c) => c.slug)).toEqual([
      'about',
      'team',
      'hello-rome',
      'draft-idea',
      'old',
    ]);
    expect(data.content.map((c) => c.status)).toEqual([
      'published',
      'published',
      'published',
      'draft',
      'trash',
    ]);
    const post = data.content.find((c) => c.slug === 'hello-rome')!;
    expect(post.meta).toEqual({ subtitle: 'A trip', featured_image: 5 });
    expect(post.terms).toEqual({ category: ['italy'], tag: ['rome'] });
    expect(post.publishedAt).toBe('2024-05-01T10:00:00.000Z');
    expect(data.terms.map((t) => t.slug).sort()).toEqual(['italy', 'rome', 'travel']);
    expect(data.settings).toMatchObject({ site_title: 'Old & Gold', tagline: 'Since 1999' });
    expect(data.authors).toEqual([
      { id: site.editor.id, email: 'editor@example.com', displayName: expect.any(String) },
    ]);
    const json = JSON.stringify(data);
    expect(json).not.toMatch(/passwordHash|fake\$|token/i);
  });
});

describe('importSite (round trip)', () => {
  it('restores content, hierarchy, fields, terms and settings into a fresh site', async () => {
    const source = await makeSite();
    const { about } = await seed(source);
    const exported = JSON.parse(JSON.stringify(await exportSite(source.deps))) as SiteExport;

    const target = await makeSite();
    const summary = await importSite(exported, target.deps, {
      defaultAuthorId: target.admin.id,
      skipMeta: ['featured_image'],
      resolveAuthor: async (author) => (await target.users.findByEmail(author.email))?.id ?? null,
    });
    expect(summary).toMatchObject({ terms: 3, content: 5, skipped: [], warnings: [] });

    const items = await target.content.list({
      status: ['draft', 'published', 'trash'],
      orderBy: 'id',
      direction: 'asc',
    });
    expect(items.map((i) => [i.slug, i.status])).toEqual([
      ['about', 'published'],
      ['team', 'published'],
      ['hello-rome', 'published'],
      ['draft-idea', 'draft'],
      ['old', 'trash'],
    ]);
    const [newAbout, team, post] = items;
    expect(team!.parentId).toBe(newAbout!.id);
    expect(post!.publishedAt?.toISOString()).toBe('2024-05-01T10:00:00.000Z');
    expect(post!.excerpt).toBe('Ciao');
    expect(post!.body).toEqual([{ type: 'core/paragraph', content: [{ text: 'Ciao!' }] }]);
    // The author is matched by email to the same person on the new site.
    const sameEditor = await target.users.findByEmail('editor@example.com');
    expect(post!.authorId).toBe(sameEditor!.id);

    // Custom fields come back, except the media pointer.
    const metas = await target.deps.meta!.getMetaMany(items.map((i) => i.id));
    expect(metas.get(post!.id)).toEqual({ subtitle: 'A trip' });

    const terms = await target.taxonomies.getContentTerms(post!.id);
    expect(terms.map((t) => `${t.taxonomy}:${t.slug}`).sort()).toEqual([
      'category:italy',
      'tag:rome',
    ]);
    const italy = await target.taxonomies.getTermBySlug('category', 'italy');
    const travel = await target.taxonomies.getTermBySlug('category', 'travel');
    expect(italy!.parentId).toBe(travel!.id);

    const settings = await target.settings.getAll();
    expect(settings).toMatchObject({
      site_title: 'Old & Gold',
      tagline: 'Since 1999',
      posts_per_page: 5,
    });
    expect(settings.front_page_id).toBe(newAbout!.id);
    expect(summary.idMap[String(about.id)]).toBe(newAbout!.id);
  });

  it('adds next to existing content and never overwrites it', async () => {
    const site = await makeSite();
    await seed(site);
    const exported = JSON.parse(JSON.stringify(await exportSite(site.deps))) as SiteExport;
    const before = await site.content.list({ status: ['draft', 'published', 'trash'] });
    const summary = await importSite(exported, site.deps, { defaultAuthorId: site.admin.id });
    expect(summary.content).toBe(5);
    expect(summary.terms).toBe(0);
    const after = await site.content.list({ status: ['draft', 'published', 'trash'], limit: 100 });
    expect(after).toHaveLength(before.length + 5);
    const slugs = after
      .filter((i) => i.type === 'post' && i.title === 'Hello Rome')
      .map((i) => i.slug);
    expect(new Set(slugs).size).toBe(2);
  });

  it('refuses a file that is not an export, and changes nothing', async () => {
    const site = await makeSite();
    for (const bad of [
      null,
      [],
      {},
      { format: 'other' },
      { format: 'nodepress-export', version: 2 },
    ]) {
      await expect(importSite(bad, site.deps)).rejects.toThrow(/not a NodePress export/);
    }
    const broken = {
      format: 'nodepress-export',
      version: 1,
      exportedAt: 'x',
      settings: {},
      terms: [],
      authors: [],
      content: [{ id: 1 }],
    };
    await expect(importSite(broken, site.deps)).rejects.toThrow(/not a NodePress export/);
    expect(await site.content.list({ status: ['draft', 'published', 'trash'] })).toHaveLength(0);
  });

  it('skips an item that cannot be created and imports the rest', async () => {
    const site = await makeSite();
    await seed(site);
    const exported = JSON.parse(JSON.stringify(await exportSite(site.deps))) as SiteExport;
    // A scheduled item needs a future date; this one is in the past, so the service refuses it.
    exported.content[2]!.status = 'scheduled';
    exported.content[2]!.publishedAt = '2000-01-01T00:00:00.000Z';
    const target = await makeSite();
    const summary = await importSite(exported, target.deps, { defaultAuthorId: target.admin.id });
    expect(summary.content).toBe(4);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]!.title).toBe('Hello Rome');
  });
});

describe('/api/v1/backup', () => {
  async function signIn(site: Site, email: string) {
    const res = await site.app.request(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    return {
      cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!,
      'x-csrf-token': csrfToken,
    };
  }

  it('needs a signed-in administrator', async () => {
    const site = await makeSite();
    expect((await site.app.request(`${BASE}/api/v1/backup/export`)).status).toBe(401);
    const editor = await signIn(site, 'editor@example.com');
    expect(
      (await site.app.request(`${BASE}/api/v1/backup/export`, { headers: editor })).status,
    ).toBe(403);
    const post = await site.app.request(`${BASE}/api/v1/backup/import`, {
      method: 'POST',
      headers: { ...editor, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(post.status).toBe(403);
  });

  it('downloads an export and reads it back through the API', async () => {
    const source = await makeSite();
    await seed(source);
    const admin = await signIn(source, 'admin@example.com');
    const res = await source.app.request(`${BASE}/api/v1/backup/export`, { headers: admin });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="nodepress-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const file = await res.text();

    const target = await makeSite();
    const targetAdmin = await signIn(target, 'admin@example.com');
    const imported = await target.app.request(`${BASE}/api/v1/backup/import`, {
      method: 'POST',
      headers: { ...targetAdmin, 'content-type': 'application/json' },
      body: file,
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ content: 5, terms: 3, skipped: [] });
    expect(await target.content.list({ type: 'post', status: ['published'] })).toHaveLength(1);
  });

  it('refuses other content types, bad JSON and files that are not exports', async () => {
    const site = await makeSite();
    const admin = await signIn(site, 'admin@example.com');
    const send = (body: string, type = 'application/json') =>
      site.app.request(`${BASE}/api/v1/backup/import`, {
        method: 'POST',
        headers: { ...admin, 'content-type': type },
        body,
      });
    expect((await send('{}', 'text/plain')).status).toBe(415);
    expect((await send('{nope')).status).toBe(400);
    const notExport = await send('{"hello":1}');
    expect(notExport.status).toBe(400);
    expect(await notExport.json()).toMatchObject({ error: 'invalid_export' });
  });
});
