import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createS3Storage, s3ConfigFromEnv, signS3Request } from './s3-storage.js';

// AWS's published Signature V4 examples (docs: "Signature Calculations for the Authorization
// Header: Transferring Payload in a Single Chunk").
const ACCESS = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const DATE = new Date('2013-05-24T00:00:00Z');
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const base = {
  host: 'examplebucket.s3.amazonaws.com',
  accessKeyId: ACCESS,
  secretAccessKey: SECRET,
  region: 'us-east-1',
  date: DATE,
};
const signatureOf = (headers: Record<string, string>) =>
  /Signature=([0-9a-f]{64})$/.exec(headers.authorization!)![1];

describe('signS3Request (AWS example vectors)', () => {
  it('signs GET Object with a Range header', () => {
    const headers = signS3Request({
      ...base,
      method: 'GET',
      path: '/test.txt',
      headers: { Range: 'bytes=0-9' },
      payloadHash: EMPTY,
    });
    expect(headers.authorization).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date');
    expect(signatureOf(headers)).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('signs PUT Object with a body, an encoded key and extra headers', () => {
    const body = 'Welcome to Amazon S3.';
    const headers = signS3Request({
      ...base,
      method: 'PUT',
      path: '/test$file.text',
      headers: {
        Date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payloadHash: createHash('sha256').update(body).digest('hex'),
    });
    expect(headers['x-amz-content-sha256']).toBe(
      '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    );
    expect(signatureOf(headers)).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('signs a request with a sub-resource query', () => {
    const headers = signS3Request({
      ...base,
      method: 'GET',
      path: '/',
      query: { lifecycle: '' },
      payloadHash: EMPTY,
    });
    expect(signatureOf(headers)).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('signs a request with several query parameters', () => {
    const headers = signS3Request({
      ...base,
      method: 'GET',
      path: '/',
      query: { 'max-keys': '2', prefix: 'J' },
      payloadHash: EMPTY,
    });
    expect(signatureOf(headers)).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeS3(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fake, calls };
}

const config = {
  bucket: 'my-bucket',
  region: 'eu-west-1',
  accessKeyId: ACCESS,
  secretAccessKey: SECRET,
  now: () => DATE,
};

describe('S3 storage', () => {
  it('puts a file with a signed, never-overwriting request (virtual-hosted style)', async () => {
    const { fake, calls } = fakeS3(() => new Response(null, { status: 200 }));
    const storage = createS3Storage({ ...config, fetch: fake });
    await storage.put('uploads/2026/11/cat-1.png', Buffer.from('abc'), 'image/png');
    const call = calls[0]!;
    expect(call.url).toBe('https://my-bucket.s3.eu-west-1.amazonaws.com/uploads/2026/11/cat-1.png');
    expect(call.method).toBe('PUT');
    expect(call.headers['content-type']).toBe('image/png');
    expect(call.headers['if-none-match']).toBe('*');
    expect(call.headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update('abc').digest('hex'),
    );
    expect(call.headers.authorization).toContain(`Credential=${ACCESS}/20130524/eu-west-1/s3/aws4_request`);
    expect(call.headers.authorization).toContain('content-type;');
    expect(call.headers.host).toBeUndefined();
  });

  it('uses path-style addressing with a custom endpoint (MinIO)', async () => {
    const { fake, calls } = fakeS3(() => new Response(null, { status: 200 }));
    const storage = createS3Storage({ ...config, endpoint: 'http://minio:9000/', fetch: fake });
    await storage.put('uploads/a.png', Buffer.from('x'), 'image/png');
    expect(calls[0]!.url).toBe('http://minio:9000/my-bucket/uploads/a.png');
  });

  it('uses path-style addressing on AWS for bucket names with dots', async () => {
    const { fake, calls } = fakeS3(() => new Response(null, { status: 200 }));
    const storage = createS3Storage({ ...config, bucket: 'my.dotted.bucket', fetch: fake });
    await storage.delete('uploads/a.png');
    expect(calls[0]!.url).toBe('https://s3.eu-west-1.amazonaws.com/my.dotted.bucket/uploads/a.png');
  });

  it('refuses to overwrite when the service answers 412', async () => {
    const { fake } = fakeS3(() => new Response('', { status: 412 }));
    const storage = createS3Storage({ ...config, fetch: fake });
    await expect(storage.put('uploads/a.png', Buffer.from('x'), 'image/png')).rejects.toThrow(
      /exists/,
    );
  });

  it('gets a file and returns undefined for a missing key', async () => {
    const { fake, calls } = fakeS3((call) =>
      call.url.endsWith('/uploads/a.png')
        ? new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }),
    );
    const storage = createS3Storage({ ...config, fetch: fake });
    expect([...(await storage.get('uploads/a.png'))!]).toEqual([1, 2, 3]);
    expect(await storage.get('uploads/missing.png')).toBeUndefined();
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['x-amz-content-sha256']).toBe(EMPTY);
  });

  it('deletes a file and treats a missing key as success', async () => {
    const { fake, calls } = fakeS3((call) =>
      call.url.endsWith('/gone.png') ? new Response('', { status: 404 }) : new Response(null, { status: 204 }),
    );
    const storage = createS3Storage({ ...config, fetch: fake });
    await storage.delete('uploads/a.png');
    await storage.delete('uploads/gone.png');
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
  });

  it('reports errors with the status and code, never credentials or signatures', async () => {
    const { fake } = fakeS3(
      () => new Response('<Error><Code>AccessDenied</Code><Message>nope</Message></Error>', { status: 403 }),
    );
    const storage = createS3Storage({ ...config, fetch: fake });
    const error = await storage.get('uploads/a.png').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('HTTP 403 AccessDenied');
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('Signature=');
  });

  it('does not follow redirects, which would resend a signed request', async () => {
    let init: RequestInit | undefined;
    const storage = createS3Storage({
      ...config,
      fetch: (async (_url: string | URL | Request, i?: RequestInit) => {
        init = i;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    await storage.delete('uploads/a.png');
    expect(init?.redirect).toBe('error');
  });

  it('rejects unsafe keys before any request is made', async () => {
    const { fake, calls } = fakeS3(() => new Response(null, { status: 200 }));
    const storage = createS3Storage({ ...config, fetch: fake });
    await expect(storage.get('../etc/passwd')).rejects.toThrow(/Invalid storage key/);
    await expect(storage.put('uploads//a.png', Buffer.from('x'), 'image/png')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid configuration', () => {
    expect(() => createS3Storage({ ...config, bucket: 'Bad_Bucket' })).toThrow(/bucket/);
    expect(() => createS3Storage({ ...config, region: '' })).toThrow(/region/);
    expect(() => createS3Storage({ ...config, secretAccessKey: '' })).toThrow(/secret/);
    expect(() => createS3Storage({ ...config, endpoint: 'ftp://x' })).toThrow(/S3 endpoint/);
  });
});

describe('s3ConfigFromEnv', () => {
  const env = {
    S3_BUCKET: 'media',
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'id',
    S3_SECRET_ACCESS_KEY: 'super-secret-value',
  };

  it('reads the settings and the optional endpoint and public URL', () => {
    const cfg = s3ConfigFromEnv({
      ...env,
      S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      S3_PUBLIC_URL: 'https://cdn.example.com/',
    });
    expect(cfg.options.bucket).toBe('media');
    expect(cfg.options.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
    expect(cfg.publicUrl).toBe('https://cdn.example.com');
    expect(s3ConfigFromEnv(env).publicUrl).toBeUndefined();
  });

  it('names the missing variables without printing any value', () => {
    let message = '';
    try {
      s3ConfigFromEnv({ S3_BUCKET: 'media', S3_SECRET_ACCESS_KEY: 'super-secret-value' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('S3_REGION, S3_ACCESS_KEY_ID');
    expect(message).not.toContain('super-secret-value');
  });

  it('rejects a malformed public URL', () => {
    expect(() => s3ConfigFromEnv({ ...env, S3_PUBLIC_URL: 'javascript:alert(1)' })).toThrow(
      /S3_PUBLIC_URL/,
    );
  });
});
