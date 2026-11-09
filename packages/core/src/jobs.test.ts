import { describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import { silentLogger } from './logger.js';
import { PluginManager } from './plugins.js';
import { memoryJobStore } from './testing/memory-job-store.js';
import { createJobQueue, defaultBackoff, JobValidationError, LEASE_GRACE_MS } from './jobs.js';

const T0 = new Date('2030-01-01T00:00:00.000Z');

function setup() {
  let now = T0.getTime();
  const store = memoryJobStore();
  const hooks = new HookRegistry();
  const queue = createJobQueue({ store, hooks, now: () => new Date(now) });
  return {
    store,
    hooks,
    queue,
    advance(ms: number) {
      now += ms;
    },
    now: () => new Date(now),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('JobQueue', () => {
  it('runs a due job once and records it done', async () => {
    const { queue, store, hooks } = setup();
    const seen: unknown[] = [];
    const completed: number[] = [];
    hooks.addAction('job:completed', (job) => void completed.push(job.id));
    queue.registerJob<{ n: number }>({ type: 'demo', handler: (p) => void seen.push(p) });
    const job = await queue.enqueue('demo', { n: 1 });

    expect(await queue.runDue()).toEqual({ processed: 1, succeeded: 1, retried: 0, failed: 0 });
    expect(seen).toEqual([{ n: 1 }]);
    expect(store.rows.get(job.id)).toMatchObject({ status: 'done', attempts: 1 });
    expect(completed).toEqual([job.id]);
    expect(await queue.runDue()).toMatchObject({ processed: 0 });
  });

  it('waits for runAt and runs jobs in due order', async () => {
    const { queue, advance } = setup();
    const order: string[] = [];
    queue.registerJob<string>({ type: 'demo', handler: (p) => void order.push(p) });
    await queue.enqueue('demo', 'later', { delayMs: 10_000 });
    await queue.enqueue('demo', 'soon', { delayMs: 1000 });
    await queue.enqueue('demo', 'now');

    await queue.runDue();
    expect(order).toEqual(['now']);
    advance(5000);
    await queue.runDue();
    expect(order).toEqual(['now', 'soon']);
    advance(10_000);
    await queue.runDue();
    expect(order).toEqual(['now', 'soon', 'later']);
  });

  it('honours the batch limit', async () => {
    const { queue } = setup();
    queue.registerJob({ type: 'demo', handler: () => {} });
    for (let i = 0; i < 5; i++) await queue.enqueue('demo');
    expect((await queue.runDue(2)).processed).toBe(2);
    expect((await queue.runDue()).processed).toBe(3);
  });

  it('retries with backoff and records the failure after the last attempt', async () => {
    const { queue, store, hooks, advance } = setup();
    const events: string[] = [];
    hooks.addAction('job:retry', (_job, info) => void events.push(`retry:${info.error}`));
    hooks.addAction('job:failed', (_job, info) => void events.push(`failed:${info.error}`));
    let calls = 0;
    queue.registerJob({
      type: 'flaky',
      maxAttempts: 3,
      backoff: (attempt) => attempt * 1000,
      handler: () => {
        calls++;
        throw new Error(`boom ${calls}`);
      },
    });
    const job = await queue.enqueue('flaky');

    expect(await queue.runDue()).toMatchObject({ retried: 1, failed: 0 });
    expect(store.rows.get(job.id)).toMatchObject({ status: 'pending', lastError: 'boom 1' });
    expect(store.rows.get(job.id)?.runAt.getTime()).toBe(T0.getTime() + 1000);

    // Not due yet.
    expect(await queue.runDue()).toMatchObject({ processed: 0 });
    advance(1000);
    expect(await queue.runDue()).toMatchObject({ retried: 1 });
    expect(store.rows.get(job.id)?.runAt.getTime()).toBe(T0.getTime() + 1000 + 2000);

    advance(2000);
    expect(await queue.runDue()).toMatchObject({ failed: 1, retried: 0 });
    expect(store.rows.get(job.id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      lastError: 'boom 3',
    });
    expect(events).toEqual(['retry:boom 1', 'retry:boom 2', 'failed:boom 3']);

    // A failed job is never picked up again…
    advance(10 * 60 * 60 * 1000);
    expect((await queue.runDue()).processed).toBe(0);
    expect(calls).toBe(3);

    // …until someone requeues it, which resets the attempts.
    expect(await queue.retryFailed(job.id)).toBe(true);
    expect(await queue.retryFailed(job.id)).toBe(false);
    await queue.runDue();
    expect(calls).toBe(4);
    expect(store.rows.get(job.id)).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('tells the handler which attempt it is', async () => {
    const { queue, advance } = setup();
    const seen: Array<[number, boolean]> = [];
    queue.registerJob({
      type: 'demo',
      maxAttempts: 2,
      backoff: () => 0,
      handler: (_p, ctx) => {
        seen.push([ctx.attempt, ctx.isLastAttempt]);
        throw new Error('x');
      },
    });
    await queue.enqueue('demo');
    await queue.runDue();
    advance(1);
    await queue.runDue();
    expect(seen).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it('survives a throwing handler, non-Error throws and a broken backoff', async () => {
    const { queue, store } = setup();
    queue.registerJob({
      type: 'bad',
      backoff: () => {
        throw new Error('backoff broke');
      },
      handler: () => {
        throw 'just a string';
      },
    });
    const ok: string[] = [];
    queue.registerJob({ type: 'ok', handler: () => void ok.push('ran') });
    const bad = await queue.enqueue('bad');
    await queue.enqueue('ok');
    expect(await queue.runDue()).toMatchObject({ processed: 2, succeeded: 1, retried: 1 });
    expect(ok).toEqual(['ran']);
    expect(store.rows.get(bad.id)?.lastError).toBe('just a string');
    expect(store.rows.get(bad.id)?.runAt.getTime()).toBe(T0.getTime() + defaultBackoff(1));
  });

  it('treats a handler that outlives its timeout as a failed attempt', async () => {
    const { queue, store } = setup();
    queue.registerJob({
      type: 'slow',
      timeoutMs: 20,
      handler: () => new Promise<void>(() => {}),
    });
    const job = await queue.enqueue('slow');
    expect(await queue.runDue()).toMatchObject({ retried: 1 });
    expect(store.rows.get(job.id)?.lastError).toMatch(/timed out after 20 ms/);
  });

  it('leaves jobs of unregistered types alone until a handler appears', async () => {
    const { queue, store } = setup();
    const job = await queue.enqueue('later:type', { a: 1 });
    expect((await queue.runDue()).processed).toBe(0);
    expect(store.rows.get(job.id)?.status).toBe('pending');
    const seen: unknown[] = [];
    queue.registerJob({ type: 'later:type', handler: (p) => void seen.push(p) });
    await queue.runDue();
    expect(seen).toEqual([{ a: 1 }]);
  });

  it('takes over a job whose worker died once its lease has passed', async () => {
    const { queue, store, advance, now } = setup();
    const seen: number[] = [];
    queue.registerJob({
      type: 'demo',
      timeoutMs: 1000,
      handler: (_p, ctx) => void seen.push(ctx.attempt),
    });
    const job = await queue.enqueue('demo');
    // Simulate a crashed worker: claimed, never finished.
    const claimed = await store.claim(
      (await store.findById(job.id))!,
      new Date(now().getTime() + 1000 + LEASE_GRACE_MS),
    );
    expect(claimed?.status).toBe('running');

    expect((await queue.runDue()).processed).toBe(0);
    advance(1000 + LEASE_GRACE_MS);
    expect(await queue.runDue()).toMatchObject({ succeeded: 1 });
    expect(seen).toEqual([2]);
    expect(store.rows.get(job.id)?.status).toBe('done');
  });

  it('does not run two overlapping runDue() calls at once', async () => {
    const { queue } = setup();
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    queue.registerJob({
      type: 'demo',
      handler: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => (release = r));
        active--;
      },
    });
    await queue.enqueue('demo');
    const first = queue.runDue();
    await Promise.resolve();
    expect(await queue.runDue()).toMatchObject({ processed: 0 });
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect(await first).toMatchObject({ succeeded: 1 });
    expect(maxActive).toBe(1);
  });

  it('ticks on an interval after start() and stops after stop()', async () => {
    const { queue } = setup();
    const seen: number[] = [];
    queue.registerJob({ type: 'demo', handler: () => void seen.push(1) });
    await queue.enqueue('demo');
    queue.start({ intervalMs: 5 });
    queue.start({ intervalMs: 5 }); // a second start is a no-op
    expect(queue.started).toBe(true);
    for (let i = 0; i < 200 && seen.length === 0; i++) await sleep(5);
    expect(seen).toHaveLength(1);
    await queue.stop();
    expect(queue.started).toBe(false);
    await queue.enqueue('demo');
    await sleep(40);
    expect(seen).toHaveLength(1);
  });

  it('validates registrations and payloads', async () => {
    const { queue } = setup();
    const handler = () => {};
    expect(() => queue.registerJob({ type: 'Bad Type', handler })).toThrow(JobValidationError);
    expect(() => queue.registerJob({ type: 'x', handler: 'nope' as never })).toThrow(
      JobValidationError,
    );
    expect(() => queue.registerJob({ type: 'x', handler, maxAttempts: 0 })).toThrow(
      JobValidationError,
    );
    expect(() => queue.registerJob({ type: 'x', handler, timeoutMs: -1 })).toThrow(
      JobValidationError,
    );
    queue.registerJob({ type: 'dup', handler });
    expect(() => queue.registerJob({ type: 'dup', handler })).toThrow(/already registered/);

    await expect(queue.enqueue('nope nope')).rejects.toThrow(JobValidationError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(queue.enqueue('dup', cyclic)).rejects.toThrow(/JSON-serializable/);
    await expect(queue.enqueue('dup', undefined, { delayMs: -5 })).rejects.toThrow(/non-negative/);
    await expect(queue.enqueue('dup', 1, { runAt: new Date('nope') })).rejects.toThrow(
      /valid date/,
    );
    await expect(queue.list({ limit: 0 })).rejects.toThrow(JobValidationError);
  });

  it('removes handlers, per source for plugins', async () => {
    const { queue } = setup();
    const off = queue.registerJob({ type: 'a', handler: () => {} });
    expect(queue.hasJob('a')).toBe(true);
    off();
    expect(queue.hasJob('a')).toBe(false);

    const scoped = queue.scoped('my-plugin');
    scoped.registerJob({ type: 'p:one', handler: () => {} });
    scoped.registerJob({ type: 'p:two', handler: () => {} });
    queue.registerJob({ type: 'core:x', handler: () => {} });
    expect(queue.removeAllFromSource('my-plugin')).toBe(2);
    expect(queue.hasJob('p:one')).toBe(false);
    expect(queue.hasJob('core:x')).toBe(true);
  });

  it('lists jobs and purges old finished ones', async () => {
    const { queue, advance } = setup();
    queue.registerJob({ type: 'demo', handler: () => {} });
    await queue.enqueue('demo');
    await queue.enqueue('other');
    await queue.runDue();
    expect((await queue.list({ status: 'done' })).map((j) => j.type)).toEqual(['demo']);
    expect(await queue.list({ type: 'other' })).toHaveLength(1);
    expect(await queue.purgeDone(1000)).toBe(0);
    advance(10 * 60 * 1000);
    expect(await queue.purgeDone(1000)).toBe(1);
    expect(await queue.list()).toHaveLength(1);
  });
});

describe('defaultBackoff', () => {
  it('doubles and is capped at one hour', () => {
    expect(defaultBackoff(1)).toBe(30_000);
    expect(defaultBackoff(2)).toBe(60_000);
    expect(defaultBackoff(3)).toBe(120_000);
    expect(defaultBackoff(50)).toBe(60 * 60 * 1000);
  });
});

describe('jobs for plugins', () => {
  it('gives plugins a scoped job API that is removed when they deactivate', async () => {
    const { queue, hooks } = setup();
    const manager = new PluginManager(hooks, silentLogger, {});
    manager.useJobs(queue);
    const ran: unknown[] = [];
    manager.register({
      name: 'mailer',
      setup({ jobs }) {
        jobs?.registerJob({ type: 'mailer:send', handler: (p) => void ran.push(p) });
      },
    });
    manager.register({
      name: 'broken',
      setup({ jobs }) {
        jobs?.registerJob({ type: 'broken:job', handler: () => {} });
        throw new Error('setup failed');
      },
    });
    await manager.activateAll();
    expect(queue.hasJob('mailer:send')).toBe(true);
    // A plugin whose setup throws leaves nothing behind.
    expect(queue.hasJob('broken:job')).toBe(false);

    await queue.enqueue('mailer:send', { to: 'a@example.com' });
    await queue.runDue();
    expect(ran).toEqual([{ to: 'a@example.com' }]);

    await manager.deactivate('mailer');
    expect(queue.hasJob('mailer:send')).toBe(false);
    // Work queued while the plugin is off waits for it instead of being lost.
    const waiting = await queue.enqueue('mailer:send', { to: 'b@example.com' });
    expect((await queue.runDue()).processed).toBe(0);
    expect((await queue.get(waiting.id))?.status).toBe('pending');
    await manager.activate('mailer');
    await queue.runDue();
    expect(ran).toHaveLength(2);
  });

  it('works without a queue: context.jobs is simply absent', async () => {
    const { hooks } = setup();
    const manager = new PluginManager(hooks, silentLogger, {});
    let seen: unknown = 'unset';
    manager.register({ name: 'plain', setup: ({ jobs }) => void (seen = jobs) });
    await manager.activateAll();
    expect(seen).toBeUndefined();
  });
});
