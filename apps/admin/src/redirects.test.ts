import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRedirect,
  deleteRedirect,
  describeRedirectError,
  diffRedirect,
  fetchRedirects,
  importRedirectsCsv,
  redirectsToCsv,
  RedirectApiError,
  updateRedirect,
  type RedirectRule,
} from './redirects.js';

const rule = (id: number, from: string, to: string, status: 301 | 302 = 301): RedirectRule => ({
  id,
  from,
  to,
  status,
});

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body?: unknown) {
  const fn = vi.fn(async () =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body ?? {}), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('redirectsToCsv', () => {
  it('writes a header, one row per rule and quotes awkward values', () => {
    const csv = redirectsToCsv([
      rule(1, '/old', '/new'),
      rule(2, '/a,b', 'https://example.com/?q="x"', 302),
    ]);
    expect(csv).toBe('from,to,status\r\n/old,/new,301\r\n"/a,b","https://example.com/?q=""x""",302\r\n');
  });

  it('is just the header for no rules', () => {
    expect(redirectsToCsv([])).toBe('from,to,status\r\n');
  });
});

describe('diffRedirect', () => {
  const saved = rule(1, '/old', '/new');
  it('returns only what changed, trimmed', () => {
    expect(diffRedirect(saved, { from: ' /old ', to: '/newer', status: 302 })).toEqual({
      to: '/newer',
      status: 302,
    });
    expect(diffRedirect(saved, { from: '/old', to: '/new', status: 301 })).toEqual({});
  });
});

describe('describeRedirectError', () => {
  it('uses the server message for a refused rule and plain sentences otherwise', () => {
    expect(describeRedirectError(new RedirectApiError(400, 'invalid_request', 'from', 'Too long.'))).toBe(
      'Too long.',
    );
    expect(describeRedirectError(new RedirectApiError(403, 'forbidden'))).toMatch(/permission/);
    expect(describeRedirectError(new RedirectApiError(404, 'not_found'))).toMatch(/no longer exists/);
    expect(describeRedirectError(new RedirectApiError(413, 'payload_too_large'))).toMatch(/too large/);
    expect(describeRedirectError(new RedirectApiError(415, 'unsupported_media_type'))).toMatch(/CSV/);
    expect(describeRedirectError(new Error('x'))).toMatch(/went wrong/);
  });
});

describe('API calls', () => {
  it('fetchRedirects lists, answers null on 403 and throws on other failures', async () => {
    stubFetch(200, { redirects: [rule(1, '/a', '/b')] });
    expect(await fetchRedirects()).toEqual([rule(1, '/a', '/b')]);
    stubFetch(403, { error: 'forbidden' });
    expect(await fetchRedirects()).toBeNull();
    stubFetch(500, { error: 'boom' });
    await expect(fetchRedirects()).rejects.toMatchObject({ status: 500 });
  });

  it('create, update and delete send the CSRF token and surface the field error', async () => {
    const created = stubFetch(201, { redirect: rule(3, '/x', '/y') });
    await createRedirect({ from: '/x', to: '/y', status: 301 }, 'tok');
    const call = created.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/api/v1/redirects');
    expect(call[1].method).toBe('POST');
    expect(new Headers(call[1].headers).get('x-csrf-token')).toBe('tok');
    expect(JSON.parse(call[1].body as string)).toEqual({ from: '/x', to: '/y', status: 301 });

    const updated = stubFetch(200, { redirect: rule(3, '/x', '/z') });
    await updateRedirect(3, { to: '/z' }, 'tok');
    expect((updated.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/api/v1/redirects/3');

    stubFetch(400, { error: 'invalid_request', field: 'from', message: 'Reserved path.' });
    await expect(createRedirect({ from: '/admin', to: '/y', status: 301 }, 'tok')).rejects.toMatchObject({
      status: 400,
      field: 'from',
      detail: 'Reserved path.',
    });

    const deleted = stubFetch(204);
    await deleteRedirect(3, 'tok');
    expect((deleted.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('DELETE');
  });

  it('importRedirectsCsv posts the text as text/csv and returns the report', async () => {
    const fn = stubFetch(200, { created: 1, updated: 0, errors: [{ line: 3, message: 'bad' }] });
    const report = await importRedirectsCsv('from,to\n/a,/b\n', 'tok');
    expect(report.errors).toEqual([{ line: 3, message: 'bad' }]);
    const init = (fn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('content-type')).toBe('text/csv');
    expect(init.body).toBe('from,to\n/a,/b\n');
  });
});
