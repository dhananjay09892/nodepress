import { createHash, createHmac } from 'node:crypto';
import type { StorageAdapter } from './media.js';
import { assertStorageKey } from './media-storage.js';

/** Settings for an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Backblaze B2). */
export interface S3StorageOptions {
  bucket: string;
  /** `us-east-1`, or `auto` for R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Service address for non-AWS services, e.g. `http://minio:9000`. Uses path-style addressing. */
  endpoint?: string | undefined;
  /** `fetch`, injectable for tests. */
  fetch?: typeof fetch;
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Give up on a request after this long (default 30 s). */
  timeoutMs?: number;
}

export interface SignRequestInput {
  method: string;
  host: string;
  /** Raw (unencoded) path, starting with `/`. */
  path: string;
  /** Query parameters, unencoded. */
  query?: Record<string, string>;
  /** Headers to sign besides `host`, `x-amz-date` and `x-amz-content-sha256`, which are added. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body (of the empty string for GET and DELETE). */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  date: Date;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 percent-encoding as AWS Signature V4 wants it. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const encodePath = (path: string): string => path.split('/').map(uriEncode).join('/');

/**
 * AWS Signature Version 4 for one request. Returns every header to send, including
 * `Authorization`. The caller must send exactly these headers (fetch adds `host` itself).
 */
export function signS3Request(input: SignRequestInput): Record<string, string> {
  const service = input.service ?? 's3';
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {}))
    headers[name.toLowerCase()] = value;
  headers.host = input.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = input.payloadHash;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.entries(input.query ?? {})
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    input.method,
    encodePath(input.path),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_NAME = /^[a-z0-9-]{2,32}$/;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

function parseHttpUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`${name} must start with http:// or https://`);
  return url;
}

/**
 * Stores media in an S3-compatible bucket using plain `fetch` and Signature V4 (no SDK).
 *
 * - With `endpoint` the bucket is addressed in the path (`https://host/bucket/key`), which
 *   MinIO and most self-hosted services need. Without it, AWS virtual-hosted style is used
 *   (`https://bucket.s3.region.amazonaws.com/key`), except for bucket names with dots, whose
 *   names do not match the AWS certificate.
 * - `put` sends `If-None-Match: *`, so services that support conditional writes refuse to
 *   overwrite (the key names contain random bytes, so this is a second line of defence).
 * - Errors carry the status and the service's error code, never headers or credentials.
 */
export function createS3Storage(options: S3StorageOptions): StorageAdapter {
  if (!BUCKET_NAME.test(options.bucket)) throw new Error('S3 bucket name is not valid');
  if (!REGION_NAME.test(options.region)) throw new Error('S3 region is not valid');
  if (!options.accessKeyId || !options.secretAccessKey)
    throw new Error('S3 access key id and secret access key are required');
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;

  let origin: string;
  let pathPrefix: string; // '' or '/bucket'
  let hostHeader: string;
  if (options.endpoint) {
    const url = parseHttpUrl(options.endpoint, 'S3 endpoint');
    const base = url.pathname.replace(/\/+$/, '');
    origin = url.origin;
    hostHeader = url.host;
    pathPrefix = `${base}/${options.bucket}`;
  } else if (options.bucket.includes('.')) {
    hostHeader = `s3.${options.region}.amazonaws.com`;
    origin = `https://${hostHeader}`;
    pathPrefix = `/${options.bucket}`;
  } else {
    hostHeader = `${options.bucket}.s3.${options.region}.amazonaws.com`;
    origin = `https://${hostHeader}`;
    pathPrefix = '';
  }

  async function send(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    body?: Uint8Array,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    assertStorageKey(key);
    const path = `${pathPrefix}/${key}`;
    const headers = signS3Request({
      method,
      host: hostHeader,
      path,
      headers: extra,
      payloadHash: body ? sha256(body) : EMPTY_SHA256,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region,
      date: now(),
    });
    delete headers.host; // fetch sets it from the URL
    const init: RequestInit = {
      method,
      headers,
      // A redirect would resend a signed request somewhere else.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body) init.body = body as NonNullable<RequestInit['body']>;
    return doFetch(`${origin}${encodePath(path)}`, init);
  }

  async function fail(action: string, key: string, response: Response): Promise<never> {
    let code = '';
    try {
      code = /<Code>([A-Za-z0-9]+)<\/Code>/.exec((await response.text()).slice(0, 2000))?.[1] ?? '';
    } catch {
      // the body is only used for the error code
    }
    throw new Error(
      `S3 ${action} failed for ${key}: HTTP ${response.status}${code ? ` ${code}` : ''}`,
    );
  }

  return {
    async put(key, data, contentType) {
      const response = await send('PUT', key, data, {
        'content-type': contentType,
        'cache-control': CACHE_CONTROL,
        'if-none-match': '*',
      });
      if (response.status === 412) throw new Error(`exists: ${key}`);
      if (!response.ok) await fail('put', key, response);
      await response.arrayBuffer().catch(() => undefined);
    },
    async get(key) {
      const response = await send('GET', key);
      if (response.status === 404) {
        await response.arrayBuffer().catch(() => undefined);
        return undefined;
      }
      if (!response.ok) await fail('get', key, response);
      return Buffer.from(await response.arrayBuffer());
    },
    async delete(key) {
      const response = await send('DELETE', key);
      if (response.status === 404) return;
      if (!response.ok) await fail('delete', key, response);
      await response.arrayBuffer().catch(() => undefined);
    },
  };
}

export interface S3EnvConfig {
  options: S3StorageOptions;
  /** `S3_PUBLIC_URL` without a trailing slash, when files are served from there. */
  publicUrl?: string;
}

/**
 * Reads `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and
 * `S3_PUBLIC_URL`. Throws an error that names the missing or invalid variables, never their values.
 */
export function s3ConfigFromEnv(env: Record<string, string | undefined>): S3EnvConfig {
  const missing = ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length > 0)
    throw new Error(`MEDIA_STORAGE=s3 needs these environment variables: ${missing.join(', ')}`);
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  if (endpoint) parseHttpUrl(endpoint, 'S3_ENDPOINT');
  const publicUrl = env.S3_PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined;
  if (publicUrl) parseHttpUrl(publicUrl, 'S3_PUBLIC_URL');
  const options: S3StorageOptions = {
    bucket: env.S3_BUCKET!.trim(),
    region: env.S3_REGION!.trim(),
    accessKeyId: env.S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!.trim(),
    endpoint,
  };
  // Validate the names now, so a typo stops the start instead of the first upload.
  createS3Storage(options);
  return { options, ...(publicUrl ? { publicUrl } : {}) };
}
