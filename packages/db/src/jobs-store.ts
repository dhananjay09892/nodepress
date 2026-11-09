import { and, asc, desc, eq, inArray, lt, lte, or, type SQL } from 'drizzle-orm';
import type { DatabaseHandle } from './index.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

export type JobRowStatus = 'pending' | 'running' | 'done' | 'failed';

/** A row of the `jobs` table, the same on both dialects. */
export interface JobRow {
  id: number;
  type: string;
  payload: unknown;
  /**
   * When a `pending` job becomes due. While a job is `running` this is the end of its lease:
   * a worker that dies leaves the job claimable again once the lease has passed.
   */
  runAt: Date;
  attempts: number;
  status: JobRowStatus;
  lastError: string | null;
  createdAt: Date;
}

export interface NewJobRow {
  type: string;
  payload: unknown;
  runAt: Date;
}

export interface JobRowQuery {
  status?: JobRowStatus;
  type?: string;
  /** Newest first. */
  limit: number;
}

/**
 * Data access for the `jobs` table. Structurally compatible with the `JobStore` interface of
 * `@nodepress/core`, which this package does not import.
 */
export interface JobsTableStore {
  insert(row: NewJobRow): Promise<JobRow>;
  findById(id: number): Promise<JobRow | undefined>;
  /**
   * The next job of one of `types` that a worker may claim at `now`: due and `pending`, or
   * `running` with an expired lease. Oldest due time first.
   */
  findClaimable(types: string[], now: Date): Promise<JobRow | undefined>;
  /**
   * Atomically claim a job returned by `findClaimable`: it becomes `running`, its attempt count
   * goes up by one and `leaseUntil` replaces `runAt`. Returns undefined if another worker got
   * there first.
   */
  claim(job: JobRow, leaseUntil: Date): Promise<JobRow | undefined>;
  /** Mark a claimed job done. False if it is no longer the claim of this attempt. */
  complete(id: number, attempts: number): Promise<boolean>;
  /** Put a claimed job back to `pending` to run again at `runAt`. */
  retry(id: number, attempts: number, runAt: Date, error: string): Promise<boolean>;
  /** Give up on a claimed job: `failed`, with the last error kept. */
  fail(id: number, attempts: number, error: string): Promise<boolean>;
  /** Make a `failed` job `pending` again, due at `runAt`, with a fresh attempt count. */
  requeue(id: number, runAt: Date): Promise<boolean>;
  list(query: JobRowQuery): Promise<JobRow[]>;
  /** Delete `done` jobs due before `before`. Returns how many were removed. */
  purgeDone(before: Date): Promise<number>;
}

/** Jobs store for whichever dialect the handle uses. All queries are parameterized (Drizzle). */
export function createJobsStore(handle: DatabaseHandle): JobsTableStore {
  return handle.dialect === 'postgres'
    ? build(handle.db, pgSchema.jobs)
    : build(handle.db, sqliteSchema.jobs);
}

function build(
  dbAny:
    | Extract<DatabaseHandle, { dialect: 'sqlite' }>['db']
    | Extract<DatabaseHandle, { dialect: 'postgres' }>['db'],
  jobsAny: typeof sqliteSchema.jobs | typeof pgSchema.jobs,
): JobsTableStore {
  // The two dialects' builders are structurally identical here but nominally different types.
  const db = dbAny as Extract<DatabaseHandle, { dialect: 'sqlite' }>['db'];
  const jobs = jobsAny as typeof sqliteSchema.jobs;

  const ownClaim = (id: number, attempts: number): SQL | undefined =>
    and(eq(jobs.id, id), eq(jobs.status, 'running'), eq(jobs.attempts, attempts));

  return {
    async insert(row) {
      const [created] = await db.insert(jobs).values(row).returning();
      if (!created) throw new Error('Insert into jobs returned no row');
      return created;
    },
    async findById(id) {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      return row;
    },
    async findClaimable(types, now) {
      if (types.length === 0) return undefined;
      const [row] = await db
        .select()
        .from(jobs)
        .where(
          and(
            inArray(jobs.type, types),
            lte(jobs.runAt, now),
            or(eq(jobs.status, 'pending'), eq(jobs.status, 'running')),
          ),
        )
        .orderBy(asc(jobs.runAt), asc(jobs.id))
        .limit(1);
      return row;
    },
    async claim(job, leaseUntil) {
      // Compare-and-set on what findClaimable saw: only one worker can win.
      const [row] = await db
        .update(jobs)
        .set({ status: 'running', attempts: job.attempts + 1, runAt: leaseUntil })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, job.status),
            eq(jobs.attempts, job.attempts),
            eq(jobs.runAt, job.runAt),
          ),
        )
        .returning();
      return row;
    },
    async complete(id, attempts) {
      const rows = await db
        .update(jobs)
        .set({ status: 'done', lastError: null })
        .where(ownClaim(id, attempts))
        .returning({ id: jobs.id });
      return rows.length > 0;
    },
    async retry(id, attempts, runAt, error) {
      const rows = await db
        .update(jobs)
        .set({ status: 'pending', runAt, lastError: error })
        .where(ownClaim(id, attempts))
        .returning({ id: jobs.id });
      return rows.length > 0;
    },
    async fail(id, attempts, error) {
      const rows = await db
        .update(jobs)
        .set({ status: 'failed', lastError: error })
        .where(ownClaim(id, attempts))
        .returning({ id: jobs.id });
      return rows.length > 0;
    },
    async requeue(id, runAt) {
      const rows = await db
        .update(jobs)
        .set({ status: 'pending', attempts: 0, runAt })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'failed')))
        .returning({ id: jobs.id });
      return rows.length > 0;
    },
    async list(query) {
      const conditions: SQL[] = [];
      if (query.status) conditions.push(eq(jobs.status, query.status));
      if (query.type) conditions.push(eq(jobs.type, query.type));
      return db
        .select()
        .from(jobs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(jobs.id))
        .limit(query.limit);
    },
    async purgeDone(before) {
      const rows = await db
        .delete(jobs)
        .where(and(eq(jobs.status, 'done'), lt(jobs.runAt, before)))
        .returning({ id: jobs.id });
      return rows.length;
    },
  };
}
