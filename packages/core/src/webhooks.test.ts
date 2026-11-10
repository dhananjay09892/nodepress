import { describe, expect, it } from 'vitest';
import type { Content } from './content.js';
import { HookRegistry } from './hooks.js';
import { createJobQueue } from './jobs.js';
import { createOptionsService, type OptionRow, type OptionsStore } from './options.js';
import { memoryJobStore } from './testing/memory-job-store.js';
import {
  createWebhookService,
  isPrivateAddress,
  signWebhook,
  verifyWebhookSignature,
  WebhookNotFoundError,
  WebhookValidationError,
  WEBHOOK_JOB_TYPE,
  type FetchLike,
  type WebhookPayload,
} from './webhooks.js';

const T0 = new Date('2030-01-01T00:00:00.000Z');
const KEY = 'k'.repeat(40);

function optionsStore(): OptionsStore {
  const rows = new Map<string, OptionRow>();
  return {
    async getAutoloaded() {
      return [...rows.values()].filter((r) => r.autoload);
    },
    async get(key) {
      return rows.get(key);
    },
    async upsert(row) {
      rows.set(row.key, structuredClone(row));
    },
    async delete(key) {
      return rows.delete(key);
    },
  };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function setup(options: { statuses?: number[]; allowPrivateNetworks?: boolean } = {}) {
  let now = T0.getTime();
  const hooks = new HookRegistry();
  const jobStore = memoryJobStore();
  const jobs = createJobQueue({ store: jobStore, hooks, now: () => new Date(now) });
  const sent: Sent[] = [];
  const statuses = [...(options.statuses ?? [])];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return { status: statuses.shift() ?? 200 };
  };
  const webhooks = createWebhookService({
    options: createOptionsService({ store: optionsStore(), hooks }),
    jobs,
    hooks,
    signingKey: KEY,
    fetch,
    resolveHost: async (host) => (host === 'internal.example.com' ? ['10.0.0.5'] : ['93.184.216.34']),
    backoff: (attempt) => attempt * 1000,
    now: () => new Date(now),
    ...(options.allowPrivateNetworks ? { allowPrivateNetworks: true } : {}),
  });
  webhooks.attach();
  return {
    hooks,
    jobs,
    jobStore,
    webhooks,
    sent,
    advance(ms: number) {
      now += ms;
    },
  };
}

function item(overrides: Partial<Content> = {}): Content {
  return {
    id: 7,
    type: 'post',
    status: 'published',
    title: 'Hello',
    slug: 'hello',
    body: [{ type: 'paragraph', text: 'secret draft text' }],
    excerpt: null,
    authorId: 3,
    parentId: null,
    publishedAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('webhook configuration', () => {
  it('creates, lists, updates and deletes webhooks', async () => {
    const { webhooks } = setup();
    const created = await webhooks.create({
      url: 'https://hooks.example.com/in',
      events: ['content.published'],
      description: ' Deploy ',
    });
    expect(created).toMatchObject({ description: 'Deploy', active: true });
    expect(created.secret).toMatch(/^whsec_/);
    expect(await webhooks.list()).toHaveLength(1);
    expect(await webhooks.list()).not.toContainEqual(expect.objectContaining({ secret: expect.anything() }));

    const updated = await webhooks.update(created.id, { active: false, events: ['*'] });
    expect(updated).toMatchObject({ active: false, events: ['*'] });
    expect(await webhooks.delete(created.id)).toBe(true);
    expect(await webhooks.delete(created.id)).toBe(false);
    await expect(webhooks.update(created.id, {})).rejects.toBeInstanceOf(WebhookNotFoundError);
  });

  it('rejects bad input', async () => {
    const { webhooks } = setup();
    const bad = [
      { url: 'not a url' },
      { url: 'ftp://example.com/x' },
      { url: 'https://user:pw@example.com/x' },
      { url: 'https://example.com', events: [] },
      { url: 'https://example.com', events: ['content.nope'] },
      { url: 'https://example.com', events: ['webhook.ping'] },
      { url: 'https://example.com', description: 'x'.repeat(201) },
    ];
    for (const input of bad) {
      await expect(webhooks.create(input)).rejects.toBeInstanceOf(WebhookValidationError);
    }
  });

  it('refuses private and local URLs unless allowed', async () => {
    const { webhooks } = setup();
    for (const url of [
      'http://localhost:3000/x',
      'http://127.0.0.1/x',
      'http://10.1.2.3/x',
      'http://169.254.169.254/latest',
      'http://[::1]/x',
      'http://service.internal/x',
    ]) {
      await expect(webhooks.create({ url })).rejects.toBeInstanceOf(WebhookValidationError);
    }
    const open = setup({ allowPrivateNetworks: true });
    await expect(open.webhooks.create({ url: 'http://localhost:3000/x' })).resolves.toBeTruthy();
  });

  it('needs a long enough signing key', () => {
    const { hooks, jobs } = setup();
    expect(() =>
      createWebhookService({
        options: createOptionsService({ store: optionsStore(), hooks }),
        jobs,
        hooks,
        signingKey: 'short',
      }),
    ).toThrow(WebhookValidationError);
  });

  it('rotates the secret', async () => {
    const { webhooks } = setup();
    const created = await webhooks.create({ url: 'https://hooks.example.com/in' });
    const rotated = await webhooks.rotateSecret(created.id);
    expect(rotated.secret).not.toBe(created.secret);
  });
});

describe('isPrivateAddress', () => {
  it('flags internal addresses and passes public ones', () => {
    for (const a of ['127.0.0.1', '10.0.0.1', '172.16.5.5', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });
});

describe('delivery', () => {
  it('queues and sends a signed payload for a matching event', async () => {
    const { webhooks, hooks, jobs, sent } = setup();
    const hook = await webhooks.create({
      url: 'https://hooks.example.com/in',
      events: ['content.published'],
    });
    await hooks.doAction('post:saved', item(), { isNew: true });
    await hooks.doAction('post:published', item());
    expect(await jobs.list({ type: WEBHOOK_JOB_TYPE })).toHaveLength(1);

    expect(await jobs.runDue()).toMatchObject({ succeeded: 1 });
    expect(sent).toHaveLength(1);
    const call = sent[0]!;
    expect(call.url).toBe('https://hooks.example.com/in');
    expect(call.headers['x-nodepress-event']).toBe('content.published');
    const payload = JSON.parse(call.body) as WebhookPayload;
    expect(payload).toMatchObject({
      event: 'content.published',
      data: { id: 7, type: 'post', slug: 'hello', title: 'Hello', status: 'published' },
    });
    expect(call.body).not.toContain('secret draft text'); // bodies are not sent
    expect(call.headers['x-nodepress-delivery']).toBe(payload.id);
    expect(call.headers['x-nodepress-signature']).toBe(
      signWebhook(hook.secret, T0.getTime() / 1000, call.body),
    );
    expect(
      verifyWebhookSignature({
        secret: hook.secret,
        body: call.body,
        timestamp: call.headers['x-nodepress-timestamp']!,
        signature: call.headers['x-nodepress-signature']!,
        now: () => T0,
      }),
    ).toBe(true);
  });

  it('maps created, updated, trashed and deleted events and honours "*"', async () => {
    const { webhooks, hooks, jobs, sent } = setup();
    await webhooks.create({ url: 'https://hooks.example.com/in' });
    await hooks.doAction('post:saved', item(), { isNew: true });
    await hooks.doAction('post:saved', item(), { isNew: false });
    await hooks.doAction('post:trashed', item());
    await hooks.doAction('post:deleted', item());
    await jobs.runDue();
    expect(sent.map((s) => s.headers['x-nodepress-event'])).toEqual([
      'content.created',
      'content.updated',
      'content.trashed',
      'content.deleted',
    ]);
  });

  it('skips inactive webhooks, and ones deactivated or deleted before delivery', async () => {
    const { webhooks, hooks, jobs, sent } = setup();
    const off = await webhooks.create({ url: 'https://a.example.com/', active: false });
    const gone = await webhooks.create({ url: 'https://b.example.com/' });
    const paused = await webhooks.create({ url: 'https://c.example.com/' });
    await hooks.doAction('post:published', item());
    expect(await jobs.list({ type: WEBHOOK_JOB_TYPE })).toHaveLength(2);
    await webhooks.delete(gone.id);
    await webhooks.update(paused.id, { active: false });
    await jobs.runDue();
    expect(sent).toEqual([]);
    expect(off.active).toBe(false);
  });

  it('retries with backoff until the endpoint answers 2xx', async () => {
    const { webhooks, hooks, jobs, jobStore, sent, advance } = setup({ statuses: [500, 503, 204] });
    await webhooks.create({ url: 'https://hooks.example.com/in' });
    await hooks.doAction('post:published', item());

    expect(await jobs.runDue()).toMatchObject({ retried: 1 });
    expect([...jobStore.rows.values()][0]).toMatchObject({
      status: 'pending',
      lastError: 'endpoint answered HTTP 500',
    });
    expect((await jobs.runDue()).processed).toBe(0); // backoff not over
    advance(1000);
    expect(await jobs.runDue()).toMatchObject({ retried: 1 });
    advance(2000);
    expect(await jobs.runDue()).toMatchObject({ succeeded: 1 });
    expect(sent).toHaveLength(3);
    // Every retry carries the same delivery id and body.
    expect(new Set(sent.map((s) => s.headers['x-nodepress-delivery'])).size).toBe(1);
    expect(new Set(sent.map((s) => s.body)).size).toBe(1);
  });

  it('records a failure once the attempts are used up', async () => {
    const { webhooks, hooks, jobs, jobStore, advance } = setup({
      statuses: Array(10).fill(500) as number[],
    });
    await webhooks.create({ url: 'https://hooks.example.com/in' });
    await hooks.doAction('post:published', item());
    for (let i = 0; i < 6; i++) {
      await jobs.runDue();
      advance(60_000);
    }
    expect([...jobStore.rows.values()][0]).toMatchObject({ status: 'failed', attempts: 6 });
  });

  it('does not send to hosts that resolve to private addresses', async () => {
    const { webhooks, hooks, jobs, jobStore, sent } = setup();
    await webhooks.create({ url: 'https://internal.example.com/in' });
    await hooks.doAction('post:published', item());
    expect(await jobs.runDue()).toMatchObject({ retried: 1 });
    expect(sent).toEqual([]);
    expect([...jobStore.rows.values()][0]?.lastError).toMatch(/private/);
  });

  it('delivers a test ping even to an inactive webhook', async () => {
    const { webhooks, jobs, sent } = setup();
    const hook = await webhooks.create({ url: 'https://hooks.example.com/in', active: false });
    const deliveryId = await webhooks.sendTest(hook.id);
    await jobs.runDue();
    expect(sent[0]?.headers['x-nodepress-event']).toBe('webhook.ping');
    expect(sent[0]?.headers['x-nodepress-delivery']).toBe(deliveryId);
    await expect(webhooks.sendTest('missing')).rejects.toBeInstanceOf(WebhookNotFoundError);
  });

  it('signs with the new secret after a rotation', async () => {
    const { webhooks, hooks, jobs, sent } = setup();
    const hook = await webhooks.create({ url: 'https://hooks.example.com/in' });
    await hooks.doAction('post:published', item());
    const rotated = await webhooks.rotateSecret(hook.id);
    await jobs.runDue();
    const call = sent[0]!;
    const ts = Number(call.headers['x-nodepress-timestamp']);
    expect(call.headers['x-nodepress-signature']).toBe(signWebhook(rotated.secret, ts, call.body));
  });

  it('never breaks the content change when queueing fails', async () => {
    const { webhooks, hooks, jobs } = setup();
    await webhooks.create({ url: 'https://hooks.example.com/in' });
    jobs.enqueue = async () => {
      throw new Error('queue down');
    };
    await expect(hooks.doAction('post:published', item())).resolves.toBeUndefined();
  });

  it('stops listening after detach()', async () => {
    const { webhooks, hooks, jobs } = setup();
    await webhooks.create({ url: 'https://hooks.example.com/in' });
    webhooks.detach();
    await hooks.doAction('post:published', item());
    expect(await jobs.list()).toHaveLength(0);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test';
  const body = '{"a":1}';
  const ts = T0.getTime() / 1000;
  const signature = signWebhook(secret, ts, body);

  it('accepts a good signature and rejects tampering, wrong secrets and stale timestamps', () => {
    const base = { secret, body, timestamp: ts, signature, now: () => T0 };
    expect(verifyWebhookSignature(base)).toBe(true);
    expect(verifyWebhookSignature({ ...base, body: '{"a":2}' })).toBe(false);
    expect(verifyWebhookSignature({ ...base, secret: 'other' })).toBe(false);
    expect(verifyWebhookSignature({ ...base, signature: 'v1=00' })).toBe(false);
    expect(verifyWebhookSignature({ ...base, timestamp: 'abc' })).toBe(false);
    expect(verifyWebhookSignature({ ...base, now: () => new Date(T0.getTime() + 6 * 60_000) })).toBe(false);
    expect(verifyWebhookSignature({ ...base, now: () => new Date(T0.getTime() + 60_000) })).toBe(true);
  });
});
