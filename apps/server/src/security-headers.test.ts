import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CSP, HSTS_VALUE, securityHeaders } from './security-headers.js';

function app(options?: Parameters<typeof securityHeaders>[0]) {
  const a = new Hono();
  a.use('*', securityHeaders(options));
  a.get('/page', (c) => c.html('<p>hi</p>'));
  a.get('/json', (c) => c.json({ ok: true }));
  a.get('/own', () => new Response('x', { headers: { 'Content-Security-Policy': "default-src 'none'; sandbox" } }));
  a.get('/boom', () => {
    throw new Error('boom');
  });
  return a;
}

describe('securityHeaders', () => {
  it('adds the standard headers to pages and API answers', async () => {
    for (const path of ['/page', '/json', '/missing']) {
      const res = await app().request(`http://localhost${path}`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('permissions-policy')).toContain('camera=()');
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(res.headers.get('content-security-policy')).toBe(DEFAULT_CSP);
    }
  });

  it('also covers error responses', async () => {
    const res = await app().request('http://localhost/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('the default policy blocks inline and foreign scripts, plugins and framing by others', () => {
    expect(DEFAULT_CSP).toContain("script-src 'self'");
    expect(DEFAULT_CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(DEFAULT_CSP).toContain("object-src 'none'");
    expect(DEFAULT_CSP).toContain("base-uri 'self'");
    expect(DEFAULT_CSP).toContain("frame-ancestors 'self'");
    expect(DEFAULT_CSP).toContain("form-action 'self'");
  });

  it('keeps a header the route set itself (uploads keep their sandbox policy)', async () => {
    const res = await app().request('http://localhost/own');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('can use another policy or none', async () => {
    const custom = await app({ csp: "default-src 'self'" }).request('http://localhost/page');
    expect(custom.headers.get('content-security-policy')).toBe("default-src 'self'");
    const none = await app({ csp: false }).request('http://localhost/page');
    expect(none.headers.get('content-security-policy')).toBeNull();
  });

  it('sends HSTS only over HTTPS (or a trusted forwarded https)', async () => {
    expect((await app().request('http://localhost/page')).headers.get('strict-transport-security')).toBeNull();
    expect((await app().request('https://example.com/page')).headers.get('strict-transport-security')).toBe(HSTS_VALUE);
    const forwarded = { headers: { 'x-forwarded-proto': 'https' } };
    expect(
      (await app().request('http://localhost/page', forwarded)).headers.get('strict-transport-security'),
    ).toBeNull();
    expect(
      (await app({ trustProxy: true }).request('http://localhost/page', forwarded)).headers.get(
        'strict-transport-security',
      ),
    ).toBe(HSTS_VALUE);
    expect(
      (await app({ hsts: false }).request('https://example.com/page')).headers.get('strict-transport-security'),
    ).toBeNull();
  });
});
