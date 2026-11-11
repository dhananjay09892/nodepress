import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePress, silentLogger } from '@nodepress/core';
import { createDatabase, type DatabaseHandle } from '@nodepress/db';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const BASE = 'http://localhost';

let dir: string;
let database: DatabaseHandle;
let app: Hono;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'np-admin-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Admin</title>');
  await writeFile(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  await writeFile(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  database = createDatabase({ url: ':memory:' });
  await database.migrate();
  const np = createNodePress({ logger: silentLogger });
  app = createApp(np, database, { admin: { dir } });
});

afterEach(async () => {
  await database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('admin app hosting', () => {
  it('redirects /admin to /admin/', async () => {
    const res = await app.request(`${BASE}/admin`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/admin/');
  });

  it('serves index.html uncached with a CSP and framing protection', async () => {
    const res = await app.request(`${BASE}/admin/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(await res.text()).toContain('<title>Admin</title>');
  });

  it('serves hashed assets with long-lived caching and the right type', async () => {
    const res = await app.request(`${BASE}/admin/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves other files without long-lived caching', async () => {
    const res = await app.request(`${BASE}/admin/favicon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('falls back to index.html for client-side routes', async () => {
    for (const path of ['/admin/posts', '/admin/posts/12/edit', '/admin/login']) {
      const res = await app.request(`${BASE}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>Admin</title>');
    }
  });

  it('answers 404 for missing files instead of the SPA', async () => {
    const res = await app.request(`${BASE}/admin/assets/missing.js`);
    expect(res.status).toBe(404);
  });

  it('does not serve files outside the admin directory', async () => {
    await writeFile(join(dir, '..', 'np-secret.txt'), 'secret');
    for (const path of [
      '/admin/../np-secret.txt',
      '/admin/%2e%2e/np-secret.txt',
      '/admin/..%2fnp-secret.txt',
      '/admin/assets/..%5c..%5cnp-secret.txt',
      '/admin/%00',
    ]) {
      const res = await app.request(`${BASE}${path}`);
      expect(await res.text()).not.toContain('secret');
    }
    await rm(join(dir, '..', 'np-secret.txt'), { force: true });
  });

  it('reports a missing build instead of crashing', async () => {
    await rm(join(dir, 'index.html'));
    const res = await app.request(`${BASE}/admin/`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'admin_not_built' });
  });

  it('is not mounted unless configured', async () => {
    const np = createNodePress({ logger: silentLogger });
    const plain = createApp(np, database);
    const res = await plain.request(`${BASE}/admin/`);
    expect(res.status).toBe(404);
  });
});
