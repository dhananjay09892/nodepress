import { describe, expect, it } from 'vitest';
import {
  downloadFile,
  DownloadError,
  filenameFromUrl,
  runPool,
  type DownloadFetch,
  type DownloadResponse,
} from './media-download.js';

const bodyOf = (...chunks: number[][]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });

function response(
  status: number,
  options: { headers?: Record<string, string>; body?: number[][] | null } = {},
): DownloadResponse {
  const headers = new Map(
    Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: options.body === null ? null : bodyOf(...(options.body ?? [[1, 2, 3]])),
  };
}

const publicResolver = async () => ['93.184.216.34'];

async function failure(promise: Promise<unknown>): Promise<DownloadError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DownloadError);
    return error as DownloadError;
  }
  throw new Error('expected a DownloadError');
}

describe('downloadFile', () => {
  it('downloads a file and reports its type, address and name', async () => {
    const seen: string[] = [];
    const fetch: DownloadFetch = async (url) => {
      seen.push(url);
      return response(200, {
        headers: { 'content-type': 'Image/JPEG; charset=binary', 'content-length': '5' },
        body: [
          [1, 2],
          [3, 4, 5],
        ],
      });
    };
    const file = await downloadFile('https://old.example.com/wp-content/uploads/My%20Photo.jpg', {
      fetch,
      resolveHost: publicResolver,
    });
    expect([...file.data]).toEqual([1, 2, 3, 4, 5]);
    expect(file.contentType).toBe('image/jpeg');
    expect(file.filename).toBe('My Photo.jpg');
    expect(file.finalUrl).toBe('https://old.example.com/wp-content/uploads/My%20Photo.jpg');
    expect(seen).toHaveLength(1);
  });

  it('refuses addresses that are not http(s), have credentials or are malformed', async () => {
    const fetch: DownloadFetch = async () => response(200);
    for (const bad of [
      'ftp://example.com/a.png',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'nope',
      'https://u:p@example.com/a.png',
    ]) {
      expect(
        (await failure(downloadFile(bad, { fetch, resolveHost: publicResolver }))).reason,
      ).toBe('invalid_url');
    }
  });

  it('refuses private, loopback and local targets, by address and by name', async () => {
    let calls = 0;
    const fetch: DownloadFetch = async () => {
      calls++;
      return response(200);
    };
    for (const bad of [
      'http://127.0.0.1/a.png',
      'http://10.0.0.5/a.png',
      'http://192.168.1.1/a.png',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/a.png',
      'http://localhost/a.png',
      'http://printer.local/a.png',
    ]) {
      expect(
        (await failure(downloadFile(bad, { fetch, resolveHost: publicResolver }))).reason,
      ).toBe('blocked_host');
    }
    // A public-looking name that resolves to a private address.
    const sneaky = await failure(
      downloadFile('https://cdn.example.com/a.png', {
        fetch,
        resolveHost: async () => ['10.1.2.3'],
      }),
    );
    expect(sneaky.reason).toBe('blocked_host');
    const mixed = await failure(
      downloadFile('https://cdn.example.com/a.png', {
        fetch,
        resolveHost: async () => ['93.184.216.34', '127.0.0.1'],
      }),
    );
    expect(mixed.reason).toBe('blocked_host');
    expect(calls).toBe(0);
  });

  it('can be told to allow private networks', async () => {
    const fetch: DownloadFetch = async () => response(200);
    const file = await downloadFile('http://127.0.0.1/a.png', {
      fetch,
      allowPrivateNetworks: true,
    });
    expect(file.data.byteLength).toBe(3);
  });

  it('follows redirects but checks every hop and stops after a few', async () => {
    const fetch: DownloadFetch = async (url) => {
      if (url === 'https://a.example.com/x.png')
        return response(302, { headers: { location: '/y.png' } });
      if (url === 'https://a.example.com/y.png')
        return response(301, { headers: { location: 'https://b.example.com/z.png' } });
      return response(200, { body: [[9]] });
    };
    const file = await downloadFile('https://a.example.com/x.png', {
      fetch,
      resolveHost: publicResolver,
    });
    expect(file.finalUrl).toBe('https://b.example.com/z.png');
    expect(file.filename).toBe('z.png');

    const toPrivate: DownloadFetch = async () =>
      response(302, { headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    expect(
      (
        await failure(
          downloadFile('https://a.example.com/x.png', {
            fetch: toPrivate,
            resolveHost: publicResolver,
          }),
        )
      ).reason,
    ).toBe('blocked_host');

    const loop: DownloadFetch = async () => response(302, { headers: { location: '/again' } });
    expect(
      (
        await failure(
          downloadFile('https://a.example.com/x.png', {
            fetch: loop,
            resolveHost: publicResolver,
            maxRedirects: 2,
          }),
        )
      ).reason,
    ).toBe('too_many_redirects');

    const noLocation: DownloadFetch = async () => response(302);
    expect(
      (
        await failure(
          downloadFile('https://a.example.com/x.png', {
            fetch: noLocation,
            resolveHost: publicResolver,
          }),
        )
      ).reason,
    ).toBe('http_error');
  });

  it('refuses a file that is too large by header and while streaming', async () => {
    const declared: DownloadFetch = async () =>
      response(200, { headers: { 'content-length': '5000' } });
    expect(
      (
        await failure(
          downloadFile('https://a.example.com/x.png', {
            fetch: declared,
            resolveHost: publicResolver,
            maxBytes: 1000,
          }),
        )
      ).reason,
    ).toBe('too_large');

    const streamed: DownloadFetch = async () =>
      response(200, {
        body: [
          [1, 2, 3, 4],
          [5, 6, 7, 8],
        ],
      });
    expect(
      (
        await failure(
          downloadFile('https://a.example.com/x.png', {
            fetch: streamed,
            resolveHost: publicResolver,
            maxBytes: 6,
          }),
        )
      ).reason,
    ).toBe('too_large');
  });

  it('reports HTTP errors, network errors and timeouts', async () => {
    const missing: DownloadFetch = async () => response(404);
    const e404 = await failure(
      downloadFile('https://a.example.com/x.png', { fetch: missing, resolveHost: publicResolver }),
    );
    expect(e404.reason).toBe('http_error');
    expect(e404.message).toContain('404');

    const broken: DownloadFetch = async () => {
      throw new Error('socket hang up');
    };
    expect(
      (
        await failure(
          downloadFile('https://a.example.com/x.png', {
            fetch: broken,
            resolveHost: publicResolver,
          }),
        )
      ).reason,
    ).toBe('network');

    const noHost = await failure(
      downloadFile('https://nowhere.example.com/x.png', {
        fetch: missing,
        resolveHost: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    );
    expect(noHost.reason).toBe('network');

    const hang: DownloadFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    expect(
      (
        await failure(
          downloadFile('https://a.example.com/x.png', {
            fetch: hang,
            resolveHost: publicResolver,
            timeoutMs: 20,
          }),
        )
      ).reason,
    ).toBe('timeout');
  });

  it('accepts an empty body', async () => {
    const fetch: DownloadFetch = async () => response(200, { body: null });
    const file = await downloadFile('https://a.example.com/x.png', {
      fetch,
      resolveHost: publicResolver,
    });
    expect(file.data.byteLength).toBe(0);
  });
});

describe('filenameFromUrl', () => {
  it('takes the last segment, decoded, and falls back to "file"', () => {
    expect(filenameFromUrl('https://a.test/dir/pic%20one.png?x=1')).toBe('pic one.png');
    expect(filenameFromUrl('https://a.test/')).toBe('file');
    expect(filenameFromUrl('not a url')).toBe('file');
    expect(filenameFromUrl('https://a.test/%E0%A4%A')).toBe('file');
  });
});

describe('runPool', () => {
  it('limits concurrency and keeps the input order', async () => {
    let running = 0;
    let peak = 0;
    const results = await runPool([30, 5, 20, 1, 10, 2], 2, async (ms, index) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return index * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await runPool([], 3, async () => 1)).toEqual([]);
  });
});
