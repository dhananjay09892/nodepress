import type { JobRecord, JobStore } from '../jobs.js';

/** In-memory JobStore with the same claim/lease semantics as the database one. */
export function memoryJobStore(): JobStore & { rows: Map<number, JobRecord> } {
  const rows = new Map<number, JobRecord>();
  let nextId = 1;
  const own = (id: number, attempts: number) => {
    const row = rows.get(id);
    return row && row.status === 'running' && row.attempts === attempts ? row : undefined;
  };
  return {
    rows,
    async insert(row) {
      const rec: JobRecord = {
        id: nextId++,
        ...row,
        attempts: 0,
        status: 'pending',
        lastError: null,
        createdAt: new Date(),
      };
      rows.set(rec.id, rec);
      return { ...rec };
    },
    async findById(id) {
      const r = rows.get(id);
      return r && { ...r };
    },
    async findClaimable(types, now) {
      const due = [...rows.values()]
        .filter(
          (r) =>
            types.includes(r.type) &&
            r.runAt.getTime() <= now.getTime() &&
            (r.status === 'pending' || r.status === 'running'),
        )
        .sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.id - b.id);
      return due[0] && { ...due[0] };
    },
    async claim(job, leaseUntil) {
      const r = rows.get(job.id);
      if (
        !r ||
        r.status !== job.status ||
        r.attempts !== job.attempts ||
        r.runAt.getTime() !== job.runAt.getTime()
      ) {
        return undefined;
      }
      r.status = 'running';
      r.attempts += 1;
      r.runAt = leaseUntil;
      return { ...r };
    },
    async complete(id, attempts) {
      const r = own(id, attempts);
      if (!r) return false;
      r.status = 'done';
      r.lastError = null;
      return true;
    },
    async retry(id, attempts, runAt, error) {
      const r = own(id, attempts);
      if (!r) return false;
      Object.assign(r, { status: 'pending', runAt, lastError: error });
      return true;
    },
    async fail(id, attempts, error) {
      const r = own(id, attempts);
      if (!r) return false;
      Object.assign(r, { status: 'failed', lastError: error });
      return true;
    },
    async requeue(id, runAt) {
      const r = rows.get(id);
      if (!r || r.status !== 'failed') return false;
      Object.assign(r, { status: 'pending', attempts: 0, runAt });
      return true;
    },
    async list(query) {
      return [...rows.values()]
        .filter((r) => (!query.status || r.status === query.status) && (!query.type || r.type === query.type))
        .sort((a, b) => b.id - a.id)
        .slice(0, query.limit)
        .map((r) => ({ ...r }));
    },
    async purgeDone(before) {
      let n = 0;
      for (const r of [...rows.values()]) {
        if (r.status === 'done' && r.runAt.getTime() < before.getTime()) {
          rows.delete(r.id);
          n++;
        }
      }
      return n;
    },
  };
}
