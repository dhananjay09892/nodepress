import {
  createApiTokensService,
  createCapabilities,
  createJobQueue,
  createNodePress,
  createOptionsService,
  createSessionsService,
  createUsersService,
  silentLogger,
  type PasswordHasher,
} from '@nodepress/core';
import {
  createApiTokensStore,
  createDatabase,
  createJobsStore,
  createOptionsStore,
  createParameterizedRunner,
  createSessionsStore,
  createSqlRunner,
  createUsersStore,
  type DatabaseHandle,
} from '@nodepress/db';
import { PIXEL, type Summary } from '@nodepress/plugin-analytics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { registerBuiltInDatabasePlugins } from './builtin-plugins.js';

const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake$${password}`,
  verify: async (hash, password) => hash === `fake$${password}`,
};
const PASSWORD = 'correct horse battery staple';
const BASE = 'http://blog.test';
const API = `${BASE}/api/v1/plugins/analytics`;
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
const IP = '203.0.113.77';

let database: DatabaseHandle;
let app: ReturnType<typeof createApp>;
let np: ReturnType<typeof createNodePress>;
let jobs: ReturnType<typeof createJobQueue>;
let now: Date;

const today = () => now.toISOString().slice(0, 10);

beforeEach(async () => {
  now = new Date();
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  np = createNodePress({ logger: silentLogger });
  jobs = createJobQueue({ store: createJobsStore(database), hooks: np.hooks, now: () => now });
  np.plugins.useJobs(jobs);
  np.plugins.useDatabase(createParameterizedRunner(database));
  const options = createOptionsService({ store: createOptionsStore(database), hooks: np.hooks });
  np.admin.useOptions(options);
  const registered = await registerBuiltInDatabasePlugins({
    plugins: np.plugins,
    runner: createSqlRunner(database),
    options,
    logger: silentLogger,
  });
  expect(registered).toEqual(['analytics']);
  await np.boot();
  expect(np.plugins.isActive('analytics')).toBe(true);

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
  app = createApp(np, database, {
    auth: { users, sessions, apiTokens },
    pluginRoutes: { registry: np.plugins.routes, capabilities: createCapabilities(np.hooks) },
  });
});

afterEach(async () => {
  await np.shutdown();
});

async function login(name: string) {
  const res = await app.request(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.com`, password: PASSWORD }),
  });
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

function hit(
  path: string,
  init: { agent?: string; referrer?: string; headers?: Record<string, string> } = {},
) {
  const query = new URLSearchParams({ p: path });
  if (init.referrer) query.set('r', init.referrer);
  return app.request(`${API}/hit.gif?${query}`, {
    headers: { 'user-agent': init.agent ?? CHROME, host: 'blog.test', ...init.headers },
  });
}

async function summary(query = '') {
  const { cookie } = await login('admin');
  const res = await app.request(`${API}/summary${query}`, { headers: { cookie } });
  return { res, body: (await res.json()) as Summary };
}

describe('counting', () => {
  it('serves a transparent GIF and counts the page view', async () => {
    const res = await hit('/hello');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PIXEL);
    const { body } = await summary();
    expect(body.totals).toEqual({ views: 1, visitors: 1 });
    expect(body.pages).toEqual([{ path: '/hello', views: 1 }]);
  });

  it('counts every page view but each visitor once a day', async () => {
    await hit('/a');
    await hit('/a/?utm=1');
    await hit('/b');
    await hit('/a', { agent: FIREFOX });
    const { body } = await summary();
    expect(body.totals).toEqual({ views: 4, visitors: 2 });
    expect(body.pages).toEqual([
      { path: '/a', views: 3 },
      { path: '/b', views: 1 },
    ]);
    const day = body.days.at(-1);
    expect(day).toEqual({ day: today(), views: 4, visitors: 2 });
  });

  it('keeps the referrer host, and ignores the site itself', async () => {
    await hit('/a', { referrer: 'https://www.search.example/q?x=1' });
    await hit('/a', { referrer: 'https://search.example/other' });
    await hit('/a', { referrer: 'https://blog.test/b' });
    const { body } = await summary();
    expect(body.referrers).toEqual([{ host: 'search.example', views: 2 }]);
  });

  it('counts a beacon sent with POST', async () => {
    const res = await app.request(`${API}/hit?p=%2Fposted`, {
      method: 'POST',
      headers: { 'user-agent': CHROME, host: 'blog.test' },
    });
    expect(res.status).toBe(204);
    expect((await summary()).body.pages).toEqual([{ path: '/posted', views: 1 }]);
  });

  it('puts pages beyond the daily limit under /other', async () => {
    const runner = createParameterizedRunner(database);
    for (let i = 0; i < 2000; i++) {
      await runner.execute(
        'INSERT INTO analytics_views (day, path, referrer, views) VALUES (?, ?, ?, ?)',
        [today(), `/filler-${i}`, '', 1],
      );
    }
    await hit('/one-too-many');
    const rows = await runner.query(
      'SELECT path FROM analytics_views WHERE day = ? AND path IN (?, ?)',
      [today(), '/other', '/one-too-many'],
    );
    expect(rows.map((r) => r['path'])).toEqual(['/other']);
  });
});

describe('who is not counted', () => {
  it('skips Do Not Track and Global Privacy Control', async () => {
    await hit('/a', { headers: { dnt: '1' } });
    await hit('/a', { headers: { 'sec-gpc': '1' } });
    expect((await summary()).body.totals).toEqual({ views: 0, visitors: 0 });
  });

  it('skips bots and requests without a user agent', async () => {
    await hit('/a', {
      agent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    });
    await hit('/a', { agent: 'curl/8.5.0' });
    await hit('/a', { agent: '' });
    expect((await summary()).body.totals).toEqual({ views: 0, visitors: 0 });
  });

  it('still answers with the pixel, and ignores paths that are not pages', async () => {
    for (const path of ['/api/v1/posts', '/admin', 'https://evil.example/', '']) {
      expect((await hit(path)).status).toBe(200);
    }
    expect((await summary()).body.totals).toEqual({ views: 0, visitors: 0 });
  });

  it('answers the pixel even when the database fails', async () => {
    await createSqlRunner(database).run('DROP TABLE analytics_views');
    expect((await hit('/a')).status).toBe(200);
  });
});

describe('privacy: nothing identifying is stored or set', () => {
  it('stores no IP address or user agent anywhere and sets no cookie', async () => {
    const res = await hit('/a', { headers: { 'x-forwarded-for': IP, referer: `${BASE}/a` } });
    expect(res.headers.get('set-cookie')).toBeNull();
    // A request that really carries an address (the server fills it in when it trusts its proxy).
    const beacon = await np.plugins.routes
      .match('analytics', 'GET', '/hit.gif')!
      .definition.handler({
        method: 'GET',
        path: '/hit.gif',
        params: {},
        query: { p: '/a' },
        headers: { 'user-agent': CHROME, host: 'blog.test' },
        user: null,
        clientIp: IP,
        json: async () => null,
      });
    expect(beacon.headers?.['Set-Cookie']).toBeUndefined();
    const runner = createParameterizedRunner(database);
    const dump = JSON.stringify([
      await runner.query('SELECT * FROM analytics_views', []),
      await runner.query('SELECT * FROM analytics_visitors', []),
      await runner.query('SELECT * FROM analytics_days', []),
    ]);
    expect(dump).not.toContain(IP);
    expect(dump).not.toContain('127.0.0.1');
    expect(dump).not.toContain('Mozilla');
    expect(dump).not.toContain('unknown');
    const rows = await runner.query('SELECT visitor FROM analytics_visitors', []);
    const visitor = String(rows[0]?.['visitor']);
    expect(visitor).toMatch(/^[0-9a-f]{64}$/);
  });

  it('has no column that could hold an address, agent or cookie', async () => {
    await hit('/a', { referrer: 'https://search.example/' });
    const runner = createParameterizedRunner(database);
    const names = new Set<string>();
    for (const table of ['analytics_views', 'analytics_visitors', 'analytics_days']) {
      const [row] = await runner.query(`SELECT * FROM ${table}`, []);
      for (const name of Object.keys(row ?? {})) names.add(name);
    }
    expect([...names].sort()).toEqual(['day', 'path', 'referrer', 'views', 'visitor', 'visitors']);
  });

  it('the daily job deletes visitor hashes of earlier days', async () => {
    const runner = createParameterizedRunner(database);
    await runner.execute('INSERT INTO analytics_visitors (day, visitor) VALUES (?, ?)', [
      '2020-01-01',
      'a'.repeat(64),
    ]);
    await hit('/a');
    // The pruning job is scheduled a minute after start.
    now = new Date(now.getTime() + 61_000);
    await jobs.runDue();
    const days = (await runner.query('SELECT day FROM analytics_visitors', [])).map(
      (r) => r['day'],
    );
    expect(days).toEqual([today()]);
  });
});

describe('the summary route', () => {
  it('needs a login and the manage_options capability', async () => {
    expect((await app.request(`${API}/summary`)).status).toBe(401);
    const { cookie } = await login('editor');
    expect((await app.request(`${API}/summary`, { headers: { cookie } })).status).toBe(403);
    expect((await summary()).res.status).toBe(200);
    const found = np.plugins.routes.match('analytics', 'GET', '/summary');
    expect(found?.definition.capability).toBe('manage_options');
  });

  it('covers the last 30 days by default, with a row for every day', async () => {
    const { body } = await summary();
    expect(body.days).toHaveLength(30);
    expect(body.to).toBe(today());
  });

  it('answers for a date range and rejects bad ones', async () => {
    const ok = await summary(`?from=${today()}&to=${today()}`);
    expect(ok.body.days).toHaveLength(1);
    for (const query of [
      '?from=nope',
      '?to=2026-02-30',
      `?from=${today()}&to=2020-01-01`,
      '?from=2020-01-01&to=2026-01-01',
    ]) {
      expect((await summary(query)).res.status, query).toBe(400);
    }
  });
});

describe('retention', () => {
  it('deletes rows older than the retention and keeps the rest', async () => {
    const runner = createParameterizedRunner(database);
    const old = new Date(now.getTime() - 120 * 86_400_000).toISOString().slice(0, 10);
    const recent = new Date(now.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
    for (const day of [old, recent]) {
      await runner.execute(
        'INSERT INTO analytics_views (day, path, referrer, views) VALUES (?, ?, ?, ?)',
        [day, '/a', '', 3],
      );
      await runner.execute('INSERT INTO analytics_days (day, visitors) VALUES (?, ?)', [day, 2]);
    }
    await np.admin.writePanel('analytics', 'settings', 'retention', { retention_days: 30 });
    // The job is scheduled a minute after start; run it once.
    now = new Date(now.getTime() + 61_000);
    await jobs.runDue();
    expect(
      (await runner.query('SELECT day FROM analytics_views', [])).map((r) => r['day']),
    ).toEqual([recent]);
    expect((await runner.query('SELECT day FROM analytics_days', [])).map((r) => r['day'])).toEqual(
      [recent],
    );
  });

  it('defaults to 90 days', async () => {
    const runner = createParameterizedRunner(database);
    const eighty = new Date(now.getTime() - 80 * 86_400_000).toISOString().slice(0, 10);
    const hundred = new Date(now.getTime() - 100 * 86_400_000).toISOString().slice(0, 10);
    for (const day of [eighty, hundred]) {
      await runner.execute(
        'INSERT INTO analytics_views (day, path, referrer, views) VALUES (?, ?, ?, ?)',
        [day, '/a', '', 1],
      );
    }
    now = new Date(now.getTime() + 61_000);
    await jobs.runDue();
    expect(
      (await runner.query('SELECT day FROM analytics_views', [])).map((r) => r['day']),
    ).toEqual([eighty]);
  });
});

describe('the pages', () => {
  it('adds the script and the pixel fallback to rendered pages, not to the admin', async () => {
    const page = await np.hooks.applyFilters('render:html', '<html><body><p>Hi</p></body></html>', {
      path: '/hello/',
    });
    expect(page).toContain('<script src="/api/v1/plugins/analytics/script.js" defer></script>');
    expect(page).toContain('hit.gif?p=%2Fhello');
    expect(page.indexOf('script.js')).toBeLessThan(page.indexOf('</body>'));
    const admin = await np.hooks.applyFilters('render:html', '<body></body>', { path: '/admin/x' });
    expect(admin).toBe('<body></body>');
  });

  it('serves the script as JavaScript that browsers may cache', async () => {
    const res = await app.request(`${API}/script.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toContain('max-age');
    expect(await res.text()).toContain('sendBeacon');
  });
});
