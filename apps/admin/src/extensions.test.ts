import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PanelError,
  describePanelError,
  diffPanel,
  fetchExtensions,
  fetchPageValues,
  fieldLabel,
  savePanel,
  toPanelDraft,
  type PanelField,
} from './extensions.js';

const fields: PanelField[] = [
  { name: 'site_id', type: 'text' },
  { name: 'sample_rate', type: 'number', label: 'Sample rate' },
  { name: 'enabled', type: 'boolean' },
  { name: 'region', type: 'select', options: ['eu', 'us'] },
];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), { status });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('toPanelDraft', () => {
  it('shows saved values as text and checkboxes as booleans', () => {
    expect(toPanelDraft(fields, { site_id: 'abc', sample_rate: 25, enabled: true, region: 'eu' })).toEqual(
      { site_id: 'abc', sample_rate: '25', enabled: true, region: 'eu' },
    );
  });

  it('shows missing values as empty and unchecked', () => {
    expect(toPanelDraft(fields, undefined)).toEqual({
      site_id: '',
      sample_rate: '',
      enabled: false,
      region: '',
    });
  });
});

describe('diffPanel', () => {
  const saved = { site_id: 'abc', sample_rate: 25, enabled: true, region: 'eu' };

  it('is empty for an untouched form', () => {
    expect(diffPanel(fields, saved, toPanelDraft(fields, saved))).toEqual({});
  });

  it('sends only what changed, with numbers and booleans typed', () => {
    const draft = { ...toPanelDraft(fields, saved), sample_rate: '40.5', enabled: false };
    expect(diffPanel(fields, saved, draft)).toEqual({ sample_rate: 40.5, enabled: false });
  });

  it('sends null for an emptied field', () => {
    const draft = { ...toPanelDraft(fields, saved), site_id: '', sample_rate: ' ' };
    expect(diffPanel(fields, saved, draft)).toEqual({ site_id: null, sample_rate: null });
  });

  it('sends text that is not a number as typed so the server can refuse it', () => {
    const draft = { ...toPanelDraft(fields, saved), sample_rate: 'lots' };
    expect(diffPanel(fields, saved, draft)).toEqual({ sample_rate: 'lots' });
  });

  it('does not send an untouched empty field', () => {
    expect(diffPanel(fields, {}, toPanelDraft(fields, {}))).toEqual({});
  });
});

describe('fieldLabel', () => {
  it('uses the label, or a readable form of the name', () => {
    expect(fieldLabel(fields[1]!)).toBe('Sample rate');
    expect(fieldLabel(fields[0]!)).toBe('Site id');
  });
});

describe('requests', () => {
  it('fetches the menu and pages', async () => {
    const fn = stubFetch(200, { menu: [], pages: [] });
    expect(await fetchExtensions()).toEqual({ menu: [], pages: [] });
    expect(fn.mock.calls[0]![0]).toBe('/api/v1/admin-extensions');
  });

  it('encodes the plugin and page in the URL', async () => {
    const fn = stubFetch(200, { values: { main: { a: 1 } } });
    expect(await fetchPageValues('stats', 'gen eral')).toEqual({ main: { a: 1 } });
    expect(fn.mock.calls[0]![0]).toBe('/api/v1/admin-extensions/stats/gen%20eral');
  });

  it('saves a panel with the CSRF token', async () => {
    const fn = stubFetch(200, { values: { site_id: 'abc' } });
    expect(await savePanel('stats', 'general', 'tracking', { site_id: 'abc' }, 'tok')).toEqual({
      site_id: 'abc',
    });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('/api/v1/admin-extensions/stats/general/tracking');
    expect(init?.method).toBe('PATCH');
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('tok');
    expect(init?.body).toBe(JSON.stringify({ site_id: 'abc' }));
  });

  it('keeps the field and message of a rejected value', async () => {
    stubFetch(400, { error: 'invalid_request', field: 'sample_rate', message: 'Too big' });
    const error = await savePanel('s', 'g', 'p', {}, 't').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PanelError);
    expect(error).toMatchObject({ status: 400, field: 'sample_rate', detail: 'Too big' });
  });
});

describe('describePanelError', () => {
  it('names the field that was rejected', () => {
    const error = new PanelError(400, 'invalid_request', 'sample_rate', 'Number must be at most 100');
    expect(describePanelError(error, fields)).toBe('Sample rate: Number must be at most 100');
  });

  it('explains permission and missing-page errors', () => {
    expect(describePanelError(new PanelError(403, 'forbidden', null, null))).toMatch(/permission/);
    expect(describePanelError(new PanelError(404, 'not_found', null, null))).toMatch(/no longer/);
  });

  it('handles network failures', () => {
    expect(describePanelError(new TypeError('failed'))).toMatch(/Could not reach/);
  });
});
