import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hostLooksInternal, isPrivateAddress } from './webhooks.js';

/** Why a download was refused or failed. */
export type DownloadFailure =
  | 'invalid_url'
  | 'blocked_host'
  | 'too_large'
  | 'timeout'
  | 'http_error'
  | 'too_many_redirects'
  | 'network';

export class DownloadError extends Error {
  constructor(
    readonly reason: DownloadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface DownloadResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export type DownloadFetch = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> },
) => Promise<DownloadResponse>;

export interface DownloadOptions {
  /** HTTP client, injectable for tests. Defaults to the global `fetch`. */
  fetch?: DownloadFetch;
  /** Resolves a host name to its addresses. Defaults to the system resolver. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Allow loopback and private networks (tests and trusted intranets only). Off by default. */
  allowPrivateNetworks?: boolean;
  /** Largest body accepted, in bytes. Default 10 MB. */
  maxBytes?: number;
  /** Time allowed for the whole download, redirects included. Default 20 s. */
  timeoutMs?: number;
  /** Redirects followed (each one is checked again). Default 3. */
  maxRedirects?: number;
}

export const DEFAULT_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000;
export const DEFAULT_DOWNLOAD_MAX_REDIRECTS = 3;

export interface DownloadedFile {
  data: Uint8Array;
  /** The `Content-Type` the server claimed (not trusted), without parameters. */
  contentType: string | null;
  /** The address the file finally came from, after redirects. */
  finalUrl: string;
  /** A file name taken from that address (`file` when it has none). */
  filename: string;
}

const defaultResolver = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function parse(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DownloadError('invalid_url', 'The address is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DownloadError('invalid_url', 'Only http:// and https:// addresses are downloaded.');
  }
  if (url.username || url.password) {
    throw new DownloadError('invalid_url', 'Addresses with a user name or password are refused.');
  }
  return url;
}

async function assertPublic(url: URL, options: DownloadOptions): Promise<void> {
  if (options.allowPrivateNetworks) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (hostLooksInternal(host) || isPrivateAddress(host)) {
    throw new DownloadError('blocked_host', 'The address points at a private or local network.');
  }
  if (isIP(host)) return;
  let addresses: string[];
  try {
    addresses = await (options.resolveHost ?? defaultResolver)(host);
  } catch {
    throw new DownloadError('network', `The host ${host} could not be found.`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new DownloadError(
      'blocked_host',
      'The host resolves to a private or unreachable address.',
    );
  }
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new DownloadError('too_large', `The file is larger than ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The last path segment of an address, decoded, or `file`. */
export function filenameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const decoded = decodeURIComponent(last);
    return decoded || 'file';
  } catch {
    return 'file';
  }
}

/**
 * Download one file for the importer, safely: `http(s)` only, no credentials in the address, no
 * private, loopback or link-local targets (checked on the name's DNS answer and again on every
 * redirect), a size cap that is enforced while reading, and one time limit for everything.
 */
export async function downloadFile(
  address: string,
  options: DownloadOptions = {},
): Promise<DownloadedFile> {
  const maxBytes = options.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_DOWNLOAD_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const doFetch: DownloadFetch =
    options.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<DownloadResponse>);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let url = parse(address);
    for (let hop = 0; ; hop += 1) {
      await assertPublic(url, options);
      const response = await doFetch(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'image/*,*/*;q=0.5', 'user-agent': 'NodePress-Importer' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new DownloadError('http_error', 'A redirect had no location.');
        if (hop >= maxRedirects) {
          throw new DownloadError('too_many_redirects', 'The address redirects too many times.');
        }
        url = parse(new URL(location, url).toString());
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new DownloadError('http_error', `The server answered HTTP ${response.status}.`);
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > maxBytes) {
        throw new DownloadError('too_large', `The file is larger than ${maxBytes} bytes.`);
      }
      const data = await readBody(response.body, maxBytes);
      return {
        data,
        contentType:
          response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || null,
        finalUrl: url.toString(),
        filename: filenameFromUrl(url.toString()),
      };
    }
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if (timedOut)
      throw new DownloadError('timeout', `The download took longer than ${timeoutMs} ms.`);
    throw new DownloadError('network', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Run `task` over `items` with at most `limit` at a time; results keep the input order. */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
