import type { HookRegistry } from './hooks.js';
import { silentLogger, type Logger } from './logger.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

/** A queued job as stored. */
export interface JobRecord {
  id: number;
  type: string;
  payload: unknown;
  /** When a pending job is due. While running: the end of the worker's lease. */
  runAt: Date;
  /** How many times a worker has claimed this job (including the current run). */
  attempts: number;
  status: string;
  lastError: string | null;
  createdAt: Date;
}

export type Job = JobRecord;

export interface NewJobRecord {
  type: string;
  payload: unknown;
  runAt: Date;
}

export interface JobRecordQuery {
  status?: JobStatus;
  type?: string;
  limit: number;
}

/** Storage behind the queue. `@nodepress/db` provides `createJobsStore()`. */
export interface JobStore {
  insert(row: NewJobRecord): Promise<JobRecord>;
  findById(id: number): Promise<JobRecord | undefined>;
  findClaimable(types: string[], now: Date): Promise<JobRecord | undefined>;
  claim(job: JobRecord, leaseUntil: Date): Promise<JobRecord | undefined>;
  complete(id: number, attempts: number): Promise<boolean>;
  retry(id: number, attempts: number, runAt: Date, error: string): Promise<boolean>;
  fail(id: number, attempts: number, error: string): Promise<boolean>;
  requeue(id: number, runAt: Date): Promise<boolean>;
  list(query: JobRecordQuery): Promise<JobRecord[]>;
  purgeDone(before: Date): Promise<number>;
}

declare module './hooks.js' {
  interface ActionMap {
    /** A job handler finished without throwing. */
    'job:completed': [job: Job];
    /** A job handler threw or timed out and the job will run again at `runAt`. */
    'job:retry': [job: Job, info: { error: string; runAt: Date }];
    /** A job used up its attempts (or was abandoned) and is now recorded as failed. */
    'job:failed': [job: Job, info: { error: string }];
  }
}

export interface JobContext {
  job: Job;
  /** 1 for the first run. */
  attempt: number;
  /** True on the last attempt: a throw now marks the job failed. */
  isLastAttempt: boolean;
}

export interface JobDefinition<P = unknown> {
  /** Lower-case type name, e.g. `"mailer:send"`. */
  type: string;
  handler(payload: P, context: JobContext): void | Promise<void>;
  /** Total runs allowed, first one included (default 5). */
  maxAttempts?: number;
  /** Milliseconds to wait before the next run after `attempt` failed. Default: exponential. */
  backoff?(attempt: number): number;
  /** A run that takes longer counts as failed (default 60 000 ms). */
  timeoutMs?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_RUN_BATCH = 25;
export const MAX_ERROR_LENGTH = 2000;
/** Extra time past a job's timeout before another worker may take it over. */
export const LEASE_GRACE_MS = 5_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

/** 30 s, 1 min, 2 min, 4 min… capped at one hour. */
export function defaultBackoff(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

export class JobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobValidationError';
  }
}

const TYPE_PATTERN = /^[a-z][a-z0-9_:.-]{0,99}$/;

export interface JobQueueOptions {
  store: JobStore;
  hooks: HookRegistry;
  logger?: Logger;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

export interface EnqueueOptions {
  /** Run no earlier than this. */
  runAt?: Date;
  /** Run this many milliseconds from now (ignored when `runAt` is given). */
  delayMs?: number;
}

export interface RunResult {
  processed: number;
  succeeded: number;
  retried: number;
  failed: number;
}

export interface StartOptions {
  /** How often to look for due jobs (default 5000 ms). */
  intervalMs?: number;
  /** Most jobs run per tick (default 25). */
  batch?: number;
}

/** What a plugin gets: registrations are removed again when the plugin is deactivated. */
export interface ScopedJobs {
  registerJob<P = unknown>(definition: JobDefinition<P>): () => void;
  enqueue(type: string, payload?: unknown, options?: EnqueueOptions): Promise<Job>;
}

interface Registered {
  definition: JobDefinition;
  source: string | undefined;
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message || error.name : String(error);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`Job timed out after ${ms} ms`);
    this.name = 'JobTimeoutError';
  }
}

export class JobQueue {
  readonly #store: JobStore;
  readonly #hooks: HookRegistry;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #registry = new Map<string, Registered>();
  #running: Promise<RunResult> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: JobQueueOptions) {
    this.#store = options.store;
    this.#hooks = options.hooks;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? (() => new Date());
  }

  // ── Registration ─────────────────────────────────────────────────────

  /** Register the handler for a job type. Returns a function that removes it again. */
  registerJob<P = unknown>(definition: JobDefinition<P>, source?: string): () => void {
    this.#assertType(definition?.type);
    if (typeof definition.handler !== 'function') {
      throw new JobValidationError('a job needs a handler function');
    }
    if (
      definition.maxAttempts !== undefined &&
      (!Number.isInteger(definition.maxAttempts) || definition.maxAttempts < 1)
    ) {
      throw new JobValidationError('maxAttempts must be a positive integer');
    }
    if (
      definition.timeoutMs !== undefined &&
      (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs < 1)
    ) {
      throw new JobValidationError('timeoutMs must be a positive number');
    }
    if (this.#registry.has(definition.type)) {
      throw new JobValidationError(`a handler for "${definition.type}" is already registered`);
    }
    const entry: Registered = { definition: definition as JobDefinition, source };
    this.#registry.set(definition.type, entry);
    return () => {
      if (this.#registry.get(definition.type) === entry) this.#registry.delete(definition.type);
    };
  }

  hasJob(type: string): boolean {
    return this.#registry.has(type);
  }

  /** Remove every handler registered with this source (e.g. a plugin name). */
  removeAllFromSource(source: string): number {
    let removed = 0;
    for (const [type, entry] of this.#registry) {
      if (entry.source === source) {
        this.#registry.delete(type);
        removed++;
      }
    }
    return removed;
  }

  /** A view for one plugin: its handlers go away with `removeAllFromSource(source)`. */
  scoped(source: string): ScopedJobs {
    return {
      registerJob: (definition) => this.registerJob(definition, source),
      enqueue: (type, payload, options) => this.enqueue(type, payload, options),
    };
  }

  // ── Queueing ─────────────────────────────────────────────────────────

  /**
   * Add a job. It may be enqueued before its handler is registered (it just waits). The payload
   * must survive a JSON round trip.
   */
  async enqueue(type: string, payload: unknown = null, options: EnqueueOptions = {}): Promise<Job> {
    this.#assertType(type);
    let json: string | undefined;
    try {
      json = JSON.stringify(payload);
    } catch {
      json = undefined;
    }
    if (json === undefined) throw new JobValidationError('payload must be JSON-serializable');

    let runAt = options.runAt;
    if (runAt === undefined) {
      const delay = options.delayMs ?? 0;
      if (!Number.isFinite(delay) || delay < 0) {
        throw new JobValidationError('delayMs must be a non-negative number');
      }
      runAt = new Date(this.#now().getTime() + delay);
    } else if (!(runAt instanceof Date) || Number.isNaN(runAt.getTime())) {
      throw new JobValidationError('runAt must be a valid date');
    }
    return this.#store.insert({ type, payload: JSON.parse(json) as unknown, runAt });
  }

  async get(id: number): Promise<Job | undefined> {
    return this.#store.findById(id);
  }

  /** Newest first. */
  async list(query: { status?: JobStatus; type?: string; limit?: number } = {}): Promise<Job[]> {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new JobValidationError('limit must be an integer from 1 to 200');
    }
    const q: JobRecordQuery = { limit };
    if (query.status) q.status = query.status;
    if (query.type) q.type = query.type;
    return this.#store.list(q);
  }

  /** Give a failed job a fresh set of attempts, due now. */
  async retryFailed(id: number): Promise<boolean> {
    return this.#store.requeue(id, this.#now());
  }

  /** Delete finished jobs older than `olderThanMs` (default one day). */
  async purgeDone(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
    return this.#store.purgeDone(new Date(this.#now().getTime() - olderThanMs));
  }

  // ── Running ──────────────────────────────────────────────────────────

  /**
   * Claim and run due jobs of registered types, one at a time, up to `limit`. Calls that overlap
   * an unfinished run return an empty result instead of running twice.
   */
  async runDue(limit = DEFAULT_RUN_BATCH): Promise<RunResult> {
    if (this.#running) return { processed: 0, succeeded: 0, retried: 0, failed: 0 };
    const run = this.#drain(limit);
    this.#running = run;
    try {
      return await run;
    } finally {
      this.#running = undefined;
    }
  }

  /** Check for due jobs every `intervalMs` until `stop()`. Safe to call twice. */
  start(options: StartOptions = {}): void {
    if (this.#timer) return;
    const intervalMs = options.intervalMs ?? 5000;
    const batch = options.batch ?? DEFAULT_RUN_BATCH;
    this.#timer = setInterval(() => {
      this.runDue(batch).catch((error) =>
        this.#logger.error('Job runner tick failed', { error: describeError(error) }),
      );
    }, intervalMs);
    this.#timer.unref?.();
  }

  /** Stop ticking and wait for the run in progress, if any. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  get started(): boolean {
    return this.#timer !== undefined;
  }

  async #drain(limit: number): Promise<RunResult> {
    const result: RunResult = { processed: 0, succeeded: 0, retried: 0, failed: 0 };
    while (result.processed < limit) {
      const types = [...this.#registry.keys()];
      const now = this.#now();
      const candidate = await this.#store.findClaimable(types, now);
      if (!candidate) break;
      const entry = this.#registry.get(candidate.type);
      if (!entry) continue; // unregistered since the lookup; the next lookup skips its type
      const timeoutMs = entry.definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const leaseUntil = new Date(now.getTime() + timeoutMs + LEASE_GRACE_MS);
      const job = await this.#store.claim(candidate, leaseUntil);
      if (!job) continue; // another worker took it
      result.processed++;
      const outcome = await this.#execute(job, entry.definition, timeoutMs);
      result[outcome]++;
    }
    return result;
  }

  async #execute(
    job: Job,
    definition: JobDefinition,
    timeoutMs: number,
  ): Promise<'succeeded' | 'retried' | 'failed'> {
    const maxAttempts = definition.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const context: JobContext = {
      job,
      attempt: job.attempts,
      isLastAttempt: job.attempts >= maxAttempts,
    };
    try {
      await this.#withTimeout(definition.handler(job.payload, context), timeoutMs);
    } catch (error) {
      return this.#handleFailure(job, definition, maxAttempts, error);
    }
    const finished = await this.#store.complete(job.id, job.attempts);
    if (finished) await this.#emit('job:completed', job);
    return 'succeeded';
  }

  async #handleFailure(
    job: Job,
    definition: JobDefinition,
    maxAttempts: number,
    error: unknown,
  ): Promise<'retried' | 'failed'> {
    const message = describeError(error);
    if (job.attempts >= maxAttempts) {
      this.#logger.error(`Job ${job.id} (${job.type}) failed for good`, { error: message });
      if (await this.#store.fail(job.id, job.attempts, message)) {
        await this.#emit('job:failed', { ...job, status: 'failed', lastError: message }, {
          error: message,
        });
      }
      return 'failed';
    }
    let delay = BACKOFF_BASE_MS;
    try {
      delay = (definition.backoff ?? defaultBackoff)(job.attempts);
      if (!Number.isFinite(delay) || delay < 0) delay = defaultBackoff(job.attempts);
    } catch {
      delay = defaultBackoff(job.attempts);
    }
    const runAt = new Date(this.#now().getTime() + delay);
    this.#logger.warn(`Job ${job.id} (${job.type}) failed, retrying`, {
      attempt: job.attempts,
      error: message,
    });
    if (await this.#store.retry(job.id, job.attempts, runAt, message)) {
      await this.#emit('job:retry', { ...job, status: 'pending', lastError: message, runAt }, {
        error: message,
        runAt,
      });
    }
    return 'retried';
  }

  async #withTimeout(work: void | Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(work),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new JobTimeoutError(ms)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Hook listeners are isolated by the registry; this also guards against a broken registry. */
  async #emit(name: 'job:completed', job: Job): Promise<void>;
  async #emit(name: 'job:retry', job: Job, info: { error: string; runAt: Date }): Promise<void>;
  async #emit(name: 'job:failed', job: Job, info: { error: string }): Promise<void>;
  async #emit(name: string, ...args: unknown[]): Promise<void> {
    try {
      await (this.#hooks.doAction as (n: string, ...a: unknown[]) => Promise<void>)(name, ...args);
    } catch (error) {
      this.#logger.warn(`Hook "${name}" threw`, { error: describeError(error) });
    }
  }

  #assertType(type: unknown): asserts type is string {
    if (typeof type !== 'string' || !TYPE_PATTERN.test(type)) {
      throw new JobValidationError(
        'job type must be lower-case letters, digits, ":", ".", "-" or "_", starting with a letter (max 100)',
      );
    }
  }
}

export function createJobQueue(options: JobQueueOptions): JobQueue {
  return new JobQueue(options);
}
