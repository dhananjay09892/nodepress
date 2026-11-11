import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, describeError, fetchSession, login, logout } from './api.js';

function stubFetch(response: Response) {
  const fn = vi.fn(async (_input: string, _init?: RequestInit) => response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('admin API client', () => {
  it('returns the session from /auth/me', async () => {
    const user = { id: 1, email: 'a@example.test', displayName: 'A', role: 'administrator' };
    const fetchFn = stubFetch(json({ user, csrfToken: 'csrf1' }));
    expect(await fetchSession()).toEqual({ user, csrfToken: 'csrf1' });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/v1/auth/me');
    expect(fetchFn.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  });

  it('treats 401 from /auth/me as signed out', async () => {
    stubFetch(json({ error: 'unauthenticated' }, 401));
    expect(await fetchSession()).toBeNull();
  });

  it('throws on other /auth/me failures', async () => {
    stubFetch(json({ error: 'boom' }, 500));
    await expect(fetchSession()).rejects.toMatchObject({ status: 500, code: 'boom' });
  });

  it('posts credentials as JSON on login', async () => {
    const user = { id: 1, email: 'a@example.test', displayName: 'A', role: 'administrator' };
    const fetchFn = stubFetch(json({ user, csrfToken: 'csrf2', expiresAt: 'x' }));
    const session = await login('a@example.test', 'pw');
    expect(session.csrfToken).toBe('csrf2');
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ email: 'a@example.test', password: 'pw' }));
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('surfaces the API error code when login fails', async () => {
    stubFetch(json({ error: 'invalid_credentials' }, 401));
    await expect(login('a@example.test', 'nope')).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
  });

  it('sends the CSRF token on logout', async () => {
    const fetchFn = stubFetch(new Response(null, { status: 204 }));
    await logout('csrf3');
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf3');
  });

  it('falls back to a generic code for non-JSON errors', async () => {
    stubFetch(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(fetchSession()).rejects.toMatchObject({ status: 502, code: 'request_failed' });
  });

  it('describes errors for people', () => {
    expect(describeError(new ApiError(401, 'invalid_credentials'))).toBe(
      'Wrong email or password.',
    );
    expect(describeError(new ApiError(429, 'rate_limited'))).toMatch(/Too many/);
    expect(describeError(new ApiError(500, 'x'))).toMatch(/Something went wrong/);
    expect(describeError(new TypeError('Failed to fetch'))).toMatch(/Could not reach/);
  });
});
