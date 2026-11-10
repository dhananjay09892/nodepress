import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Content } from './content.js';
import type { HookRegistry } from './hooks.js';
import type { JobQueue } from './jobs.js';
import { silentLogger, type Logger } from './logger.js';
import type { OptionsService } from './options.js';

/** Job type that delivers one webhook call. */
export const WEBHOOK_JOB_TYPE = 'webhook:deliver';
/** Option that holds the webhook configuration (a JSON array). */
export const WEBHOOKS_OPTION = 'webhooks';

export const WEBHOOK_EVENTS = [
  'content.created',
  'content.updated',
  'content.published',
  'content.trashed',
  'content.deleted',
  'webhook.ping',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const MAX_WEBHOOKS = 50;
export const MAX_WEBHOOK_URL_LENGTH = 2000;
export const MAX_WEBHOOK_DESCRIPTION_LENGTH = 200;
export const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;
export const DEFAULT_DELIVERY_ATTEMPTS = 6;
/** Receivers should reject signatures older than this. */
export const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
/** Longest error text kept from a failed delivery. */
const MAX_ERROR_TEXT = 300;

export class WebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookValidationError';
  }
}

export class WebhookNotFoundError extends Error {
  constructor(id: string) {
    super(`webhook "${id}" not found`);
    this.name = 'WebhookNotFoundError';
  }
}

/** A configured webhook, without its signing secret. */
export interface Webhook {
  id: string;
  url: string;
  /** Event names to receive, or `["*"]` for every content event. */
  events: string[];
  description: string;
  active: boolean;
  createdAt: Date;
}

interface StoredWebhook {
  id: string;
  url: string;
  events: string[];
  description: string;
  active: boolean;
  /** Mixed into the signing-secret derivation; a new one rotates the secret. */
  nonce: string;
  createdAt: string;
}

export interface CreateWebhookInput {
  url: string;
  /** Default `["*"]`. */
  events?: string[];
  description?: string;
  active?: boolean;
}

export interface UpdateWebhookInput {
  url?: string;
  events?: string[];
  description?: string;
  active?: boolean;
}

/** What a receiver gets as the request body (JSON). */
export interface WebhookPayload {
  id: string;
  event: string;
  createdAt: string;
  data: Record<string, unknown>;
}

interface DeliveryJob {
  webhookId: string;
  deliveryId: string;
  event: string;
  /** Unix seconds the signature is made for. */
  timestamp: number;
  /** The exact JSON text that is signed and sent. */
  body: string;
}

export type FetchLike = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    redirect: 'manual';
    signal: AbortSignal;
  },
) => Promise<{ status: number }>;

/** Resolve a host name to its addresses (used to refuse private networks). */
export type HostResolver = (host: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface WebhookServiceOptions {
  options: OptionsService;
  jobs: JobQueue;
  hooks: HookRegistry;
  /**
   * Server secret the per-webhook signing secrets are derived from (at least 32 characters).
   * Signing secrets are therefore never stored; they cannot be recovered without this key.
   */
  signingKey: string;
  logger?: Logger;
  /** HTTP client, injectable for tests. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  resolveHost?: HostResolver;
  /**
   * Allow URLs that point at loopback or private networks. Off by default so a webhook cannot
   * be used to reach internal services (SSRF).
   */
  allowPrivateNetworks?: boolean;
  deliveryTimeoutMs?: number;
  /** Total tries per delivery, the first included. */
  maxAttempts?: number;
  /** Delay before the next try after `attempt` failed. Defaults to the job queue's backoff. */
  backoff?(attempt: number): number;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/** `true` for loopback, private, link-local, unspecified, shared and multicast addresses. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped?.[1] ?? address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) || // unique local fc00::/7
      /^fe[89ab]/.test(lower) || // link-local fe80::/10
      lower.startsWith('ff') // multicast
    );
  }
  return false;
}

function hostLooksInternal(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (
    h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
  );
}

/** The value of the `X-NodePress-Signature` header for a request. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export interface VerifyWebhookInput {
  secret: string;
  /** The raw request body, exactly as received. */
  body: string;
  /** `X-NodePress-Timestamp` header. */
  timestamp: string | number;
  /** `X-NodePress-Signature` header. */
  signature: string;
  toleranceMs?: number;
  now?: () => Date;
}

/** Receiver-side check: right signature, and not older (or newer) than the tolerance. */
export function verifyWebhookSignature(input: VerifyWebhookInput): boolean {
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  const now = (input.now ?? (() => new Date()))().getTime();
  if (Math.abs(now - timestamp * 1000) > (input.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS)) {
    return false;
  }
  const expected = Buffer.from(signWebhook(input.secret, timestamp, input.body));
  const given = Buffer.from(String(input.signature));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function toPublic(row: StoredWebhook): Webhook {
  return {
    id: row.id,
    url: row.url,
    events: [...row.events],
    description: row.description,
    active: row.active,
    createdAt: new Date(row.createdAt),
  };
}

function isStored(value: unknown): value is StoredWebhook {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.url === 'string' &&
    Array.isArray(v.events) &&
    typeof v.nonce === 'string' &&
    typeof v.active === 'boolean'
  );
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message || error.name : String(error);
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

/**
 * Webhooks on content events. Each content change queues one `webhook:deliver` job per matching
 * webhook; the job POSTs a signed JSON body and is retried with backoff until it gets a 2xx.
 *
 * Signature: `X-NodePress-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<body>">`, with the
 * timestamp in `X-NodePress-Timestamp` (Unix seconds). The per-webhook secret is derived from the
 * server `signingKey`, so no secret is stored; it is returned once on create and on rotate.
 */
export class WebhookService {
  readonly #options: OptionsService;
  readonly #jobs: JobQueue;
  readonly #hooks: HookRegistry;
  readonly #key: string;
  readonly #logger: Logger;
  readonly #fetch: FetchLike;
  readonly #resolve: HostResolver;
  readonly #allowPrivate: boolean;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #backoff: ((attempt: number) => number) | undefined;
  readonly #now: () => Date;
  #chain: Promise<unknown> = Promise.resolve();
  #detach: (() => void)[] = [];

  constructor(o: WebhookServiceOptions) {
    if (typeof o.signingKey !== 'string' || o.signingKey.length < 32) {
      throw new WebhookValidationError('signingKey must be at least 32 characters');
    }
    this.#options = o.options;
    this.#jobs = o.jobs;
    this.#hooks = o.hooks;
    this.#key = o.signingKey;
    this.#logger = o.logger ?? silentLogger;
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.#resolve = o.resolveHost ?? defaultResolver;
    this.#allowPrivate = o.allowPrivateNetworks ?? false;
    this.#timeoutMs = o.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    this.#maxAttempts = o.maxAttempts ?? DEFAULT_DELIVERY_ATTEMPTS;
    this.#backoff = o.backoff;
    this.#now = o.now ?? (() => new Date());
  }

  // ── Configuration ────────────────────────────────────────────────────

  async list(): Promise<Webhook[]> {
    return (await this.#read()).map(toPublic);
  }

  async get(id: string): Promise<Webhook | undefined> {
    const row = (await this.#read()).find((w) => w.id === id);
    return row && toPublic(row);
  }

  /** Create a webhook. The returned `secret` is not stored and is shown only here. */
  async create(input: CreateWebhookInput): Promise<Webhook & { secret: string }> {
    const url = this.#checkUrl(input.url);
    const events = this.#checkEvents(input.events ?? ['*']);
    const description = this.#checkDescription(input.description ?? '');
    return this.#mutate(async (rows) => {
      if (rows.length >= MAX_WEBHOOKS) {
        throw new WebhookValidationError(`at most ${MAX_WEBHOOKS} webhooks are allowed`);
      }
      const row: StoredWebhook = {
        id: randomUUID(),
        url,
        events,
        description,
        active: input.active ?? true,
        nonce: randomBytes(16).toString('hex'),
        createdAt: this.#now().toISOString(),
      };
      rows.push(row);
      return { ...toPublic(row), secret: this.#secretFor(row) };
    });
  }

  async update(id: string, patch: UpdateWebhookInput): Promise<Webhook> {
    const url = patch.url === undefined ? undefined : this.#checkUrl(patch.url);
    const events = patch.events === undefined ? undefined : this.#checkEvents(patch.events);
    const description =
      patch.description === undefined ? undefined : this.#checkDescription(patch.description);
    if (patch.active !== undefined && typeof patch.active !== 'boolean') {
      throw new WebhookValidationError('active must be true or false');
    }
    return this.#mutate(async (rows) => {
      const row = rows.find((w) => w.id === id);
      if (!row) throw new WebhookNotFoundError(id);
      if (url !== undefined) row.url = url;
      if (events !== undefined) row.events = events;
      if (description !== undefined) row.description = description;
      if (patch.active !== undefined) row.active = patch.active;
      return toPublic(row);
    });
  }

  /** Replace the signing secret. Queued deliveries are signed with the new one. */
  async rotateSecret(id: string): Promise<Webhook & { secret: string }> {
    return this.#mutate(async (rows) => {
      const row = rows.find((w) => w.id === id);
      if (!row) throw new WebhookNotFoundError(id);
      row.nonce = randomBytes(16).toString('hex');
      return { ...toPublic(row), secret: this.#secretFor(row) };
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.#mutate(async (rows) => {
      const index = rows.findIndex((w) => w.id === id);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    });
  }

  /** Queue a `webhook.ping` delivery so an owner can check their endpoint. */
  async sendTest(id: string): Promise<string> {
    const row = (await this.#read()).find((w) => w.id === id);
    if (!row) throw new WebhookNotFoundError(id);
    return this.#queue(row, 'webhook.ping', { message: 'This is a test from NodePress.' });
  }

  // ── Events ───────────────────────────────────────────────────────────

  /** Start listening for content events. Safe to call twice. */
  attach(): void {
    if (this.#detach.length > 0) return;
    const source = 'core:webhooks';
    this.#detach.push(
      this.#jobs.registerJob<unknown>(
        {
          type: WEBHOOK_JOB_TYPE,
          maxAttempts: this.#maxAttempts,
          timeoutMs: this.#timeoutMs + 5000,
          ...(this.#backoff ? { backoff: this.#backoff } : {}),
          handler: (payload) => this.#deliver(payload),
        },
        source,
      ),
    );
    const on = (hook: 'post:published' | 'post:trashed' | 'post:deleted', event: WebhookEvent) =>
      this.#hooks.addAction(hook, (item) => this.#dispatch(event, item), { source });
    this.#detach.push(
      this.#hooks.addAction(
        'post:saved',
        (item, info) => this.#dispatch(info.isNew ? 'content.created' : 'content.updated', item),
        { source },
      ),
      on('post:published', 'content.published'),
      on('post:trashed', 'content.trashed'),
      on('post:deleted', 'content.deleted'),
    );
  }

  detach(): void {
    for (const off of this.#detach.splice(0)) off();
  }

  async #dispatch(event: WebhookEvent, item: Content): Promise<void> {
    try {
      const rows = (await this.#read()).filter((w) => w.active && matches(w.events, event));
      const data = {
        id: item.id,
        type: item.type,
        status: item.status,
        title: item.title,
        slug: item.slug,
        authorId: item.authorId,
        publishedAt: item.publishedAt?.toISOString() ?? null,
        updatedAt: item.updatedAt.toISOString(),
      };
      for (const row of rows) await this.#queue(row, event, data);
    } catch (error) {
      // Never let a webhook problem break the content change that triggered it.
      this.#logger.error('Could not queue webhooks', { event, error: describeError(error) });
    }
  }

  async #queue(row: StoredWebhook, event: string, data: Record<string, unknown>): Promise<string> {
    const deliveryId = randomUUID();
    const at = this.#now();
    const payload: WebhookPayload = {
      id: deliveryId,
      event,
      createdAt: at.toISOString(),
      data,
    };
    const job: DeliveryJob = {
      webhookId: row.id,
      deliveryId,
      event,
      timestamp: Math.floor(at.getTime() / 1000),
      body: JSON.stringify(payload),
    };
    await this.#jobs.enqueue(WEBHOOK_JOB_TYPE, job);
    return deliveryId;
  }

  async #deliver(payload: unknown): Promise<void> {
    if (!isDeliveryJob(payload)) return; // malformed: nothing sensible to retry
    const row = (await this.#read()).find((w) => w.id === payload.webhookId);
    // Deleted or switched off since it was queued.
    if (!row || (!row.active && payload.event !== 'webhook.ping')) return;
    await this.#assertReachable(row.url);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const response = await this.#fetch(row.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'NodePress-Webhooks/1',
        'x-nodepress-event': payload.event,
        'x-nodepress-delivery': payload.deliveryId,
        'x-nodepress-timestamp': String(payload.timestamp),
        'x-nodepress-signature': signWebhook(this.#secretFor(row), payload.timestamp, payload.body),
      },
      body: payload.body,
      redirect: 'manual', // a redirect could point somewhere private
      signal,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`endpoint answered HTTP ${response.status}`);
    }
  }

  /** Refuse private targets at send time too, since DNS answers can change after validation. */
  async #assertReachable(url: string): Promise<void> {
    if (this.#allowPrivate) return;
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : await this.#resolve(host);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new Error('webhook URL resolves to a private or unreachable address');
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  #secretFor(row: StoredWebhook): string {
    const digest = createHmac('sha256', this.#key).update(`webhook:${row.id}:${row.nonce}`);
    return `whsec_${digest.digest('base64url')}`;
  }

  async #read(): Promise<StoredWebhook[]> {
    const value = await this.#options.get(WEBHOOKS_OPTION);
    return Array.isArray(value) ? value.filter(isStored).map((w) => ({ ...w })) : [];
  }

  /** Read-modify-write, one at a time so concurrent changes in this process cannot overwrite. */
  #mutate<T>(change: (rows: StoredWebhook[]) => Promise<T>): Promise<T> {
    const run = this.#chain.then(async () => {
      const rows = await this.#read();
      const result = await change(rows);
      await this.#options.set(WEBHOOKS_OPTION, rows, { autoload: false });
      return result;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  #checkUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_WEBHOOK_URL_LENGTH) {
      throw new WebhookValidationError('url must be a non-empty string');
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new WebhookValidationError('url is not a valid URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new WebhookValidationError('url must start with http:// or https://');
    }
    if (url.username || url.password) {
      throw new WebhookValidationError('url must not contain credentials');
    }
    if (!this.#allowPrivate) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (hostLooksInternal(host) || isPrivateAddress(host)) {
        throw new WebhookValidationError('url must not point at a private or local address');
      }
    }
    return url.toString();
  }

  #checkEvents(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new WebhookValidationError('events must be a non-empty list');
    }
    const known = new Set<string>(['*', ...WEBHOOK_EVENTS.filter((e) => e !== 'webhook.ping')]);
    for (const event of value) {
      if (typeof event !== 'string' || !known.has(event)) {
        throw new WebhookValidationError(`unknown event "${String(event)}"`);
      }
    }
    return [...new Set(value as string[])];
  }

  #checkDescription(value: unknown): string {
    if (typeof value !== 'string' || value.length > MAX_WEBHOOK_DESCRIPTION_LENGTH) {
      throw new WebhookValidationError(
        `description must be text of at most ${MAX_WEBHOOK_DESCRIPTION_LENGTH} characters`,
      );
    }
    return value.trim();
  }
}

function matches(events: string[], event: string): boolean {
  return events.includes('*') || events.includes(event);
}

function isDeliveryJob(value: unknown): value is DeliveryJob {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.webhookId === 'string' &&
    typeof v.deliveryId === 'string' &&
    typeof v.event === 'string' &&
    typeof v.timestamp === 'number' &&
    typeof v.body === 'string'
  );
}

export function createWebhookService(options: WebhookServiceOptions): WebhookService {
  return new WebhookService(options);
}
