import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describePluginError,
  fetchPlugins,
  permissionLabel,
  PluginApiError,
  setPluginEnabled,
  statusLabel,
  uploadPlugin,
  type PluginPackage,
} from './plugins.js';

const plugin = (extra: Partial<PluginPackage> = {}): PluginPackage => ({
  name: 'notes',
  version: '1.0.0',
  title: 'Notes',
  permissions: [],
  hasMigrations: false,
  enabled: false,
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('plugins client', () => {
  it('permissionLabel explains known permissions and passes unknown ones through', () => {
    expect(permissionLabel('network')).toBe('Connect to other websites');
    expect(permissionLabel('something:new')).toBe('something:new');
  });

  it('statusLabel combines the owner choice with how the site is running', () => {
    expect(statusLabel(plugin())).toBe('Off');
    expect(statusLabel(plugin({ enabled: true }))).toBe('On after restart');
    expect(statusLabel(plugin({ enabled: true, status: 'active' }))).toBe('On');
    expect(statusLabel(plugin({ enabled: false, status: 'active' }))).toBe('Off after restart');
    expect(statusLabel(plugin({ enabled: true, status: 'failed' }))).toBe('Failed to start');
  });

  it('describePluginError uses the server message for invalid packages', () => {
    expect(
      describePluginError(
        new PluginApiError(400, 'invalid_plugin', 'plugin.json is not valid JSON'),
      ),
    ).toBe('plugin.json is not valid JSON');
    expect(describePluginError(new PluginApiError(400, 'invalid_plugin'))).toMatch(
      /not a valid plugin/,
    );
    expect(describePluginError(new PluginApiError(413, 'payload_too_large'))).toMatch(/20 MB/);
    expect(describePluginError(new PluginApiError(403, 'forbidden'))).toMatch(/permission/);
    expect(describePluginError(new PluginApiError(500, 'boom'))).toMatch(/Something went wrong/);
    expect(describePluginError(new Error('offline'))).toMatch(/Could not reach/);
  });

  it('fetchPlugins returns null on 403 and the overview otherwise', async () => {
    stubFetch(403, { error: 'forbidden' });
    expect(await fetchPlugins()).toBeNull();
    const overview = { plugins: [], broken: [], restartRequired: false };
    stubFetch(200, overview);
    expect(await fetchPlugins()).toEqual(overview);
    stubFetch(500, { error: 'x' });
    await expect(fetchPlugins()).rejects.toThrow();
  });

  it('uploadPlugin sends the raw zip as application/zip with the CSRF token', async () => {
    const fetchMock = stubFetch(201, { plugins: [], broken: [], restartRequired: false });
    const file = new Blob([new Uint8Array([1, 2, 3])]);
    await uploadPlugin(file, 'tok');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/plugins');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/zip');
    expect(headers.get('x-csrf-token')).toBe('tok');
  });

  it('uploadPlugin and setPluginEnabled raise PluginApiError with the server message', async () => {
    stubFetch(400, { error: 'invalid_plugin', message: 'no plugin.json' });
    await expect(uploadPlugin(new Blob(['x']), 't')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_plugin',
      detail: 'no plugin.json',
    });
    const fetchMock = stubFetch(404, { error: 'not_found' });
    await expect(setPluginEnabled('a b', true, 't')).rejects.toMatchObject({ code: 'not_found' });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/plugins/a%20b');
  });
});
