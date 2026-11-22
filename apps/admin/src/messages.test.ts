import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeMailStatus,
  describeMessagesError,
  fetchMessages,
  formatMessageDate,
  pageCount,
} from './messages.js';
import { ApiError } from './api.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body?: unknown) {
  const fn = vi.fn(
    async (_url: string) =>
      new Response(JSON.stringify(body ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('fetchMessages', () => {
  it('asks for the page and returns the list', async () => {
    const data = { total: 1, page: 2, pageSize: 20, submissions: [] };
    const fn = stubFetch(200, data);
    expect(await fetchMessages(2)).toEqual(data);
    expect(fn.mock.calls[0]?.[0]).toBe('/api/v1/contact/submissions?page=2');
  });

  it('clamps a bad page number to 1', async () => {
    const fn = stubFetch(200, { total: 0, page: 1, pageSize: 20, submissions: [] });
    await fetchMessages(-3);
    expect(fn.mock.calls[0]?.[0]).toBe('/api/v1/contact/submissions?page=1');
  });

  it('returns null for 403 and 404 so the entry stays hidden', async () => {
    stubFetch(403, { error: 'forbidden' });
    expect(await fetchMessages()).toBeNull();
    stubFetch(404);
    expect(await fetchMessages()).toBeNull();
  });

  it('throws for other failures', async () => {
    stubFetch(500, { error: 'boom' });
    await expect(fetchMessages()).rejects.toMatchObject({ status: 500, code: 'boom' });
  });
});

describe('helpers', () => {
  it('counts pages', () => {
    expect(pageCount(0, 20)).toBe(1);
    expect(pageCount(20, 20)).toBe(1);
    expect(pageCount(21, 20)).toBe(2);
    expect(pageCount(5, 0)).toBe(1);
  });

  it('describes the mail status', () => {
    expect(describeMailStatus('sent')).toBe('Emailed');
    expect(describeMailStatus('failed')).toBe('Email failed');
    expect(describeMailStatus('logged')).toBe('Not emailed (logged)');
    expect(describeMailStatus('weird')).toBe('weird');
    expect(describeMailStatus('')).toBe('Unknown');
  });

  it('formats dates and keeps invalid ones as given', () => {
    expect(formatMessageDate('2026-11-20T10:30:00.000Z', 'en-US')).toContain('2026');
    expect(formatMessageDate('nonsense')).toBe('nonsense');
  });

  it('describes errors', () => {
    expect(describeMessagesError(new ApiError(403, 'forbidden'))).toContain('permission');
    expect(describeMessagesError(new Error('x'))).toContain('Could not load');
  });
});
