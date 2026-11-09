import { describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import {
  createSessionsService,
  csrfTokenFor,
  hashSessionToken,
  verifyCsrfToken,
  type SessionRecord,
  type SessionsStore,
} from './sessions.js';
import type { User } from './users.js';

function memoryStore(): SessionsStore & { rows: Map<string, SessionRecord> } {
  const rows = new Map<string, SessionRecord>();
  return {
    rows,
    async insert(row) {
      const rec = { ...row, createdAt: new Date() };
      rows.set(row.id, rec);
      return rec;
    },
    async findById(id) {
      return rows.get(id);
    },
    async delete(id) {
      return rows.delete(id);
    },
    async deleteByUser(userId) {
      let n = 0;
      for (const [id, r] of rows) if (r.userId === userId && rows.delete(id)) n++;
      return n;
    },
    async deleteExpired(now) {
      let n = 0;
      for (const [id, r] of rows) if (r.expiresAt <= now && rows.delete(id)) n++;
      return n;
    },
  };
}

const alice: User = {
  id: 1,
  email: 'alice@example.com',
  displayName: 'Alice',
  role: 'administrator',
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function setup(ttlMs = 60_000) {
  let now = new Date('2026-01-01T00:00:00Z');
  const store = memoryStore();
  const hooks = new HookRegistry();
  const known = new Map<number, User>([[1, alice]]);
  const service = createSessionsService({
    store,
    hooks,
    ttlMs,
    now: () => now,
    users: { findById: async (id) => known.get(id) },
  });
  return { store, hooks, known, service, advance: (ms: number) => (now = new Date(+now + ms)) };
}

describe('SessionsService', () => {
  it('stores only the hash of the token', async () => {
    const { service, store } = setup();
    const created = await service.create(1);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...store.rows.keys()]).toEqual([hashSessionToken(created.token)]);
    expect(JSON.stringify([...store.rows.values()])).not.toContain(created.token);
  });

  it('validates a live token and returns the user', async () => {
    const { service } = setup();
    const { token, csrfToken } = await service.create(1);
    const active = await service.validate(token);
    expect(active?.user.email).toBe('alice@example.com');
    expect(active?.csrfToken).toBe(csrfToken);
  });

  it('rejects missing, malformed and unknown tokens', async () => {
    const { service } = setup();
    expect(await service.validate(undefined)).toBeNull();
    expect(await service.validate('')).toBeNull();
    expect(await service.validate('short')).toBeNull();
    expect(await service.validate('a'.repeat(43))).toBeNull();
  });

  it('rejects and removes expired sessions', async () => {
    const { service, store, advance } = setup(1_000);
    const { token } = await service.create(1);
    advance(1_000);
    expect(await service.validate(token)).toBeNull();
    expect(store.rows.size).toBe(0);
  });

  it('rejects sessions whose user was deleted', async () => {
    const { service, known, store } = setup();
    const { token } = await service.create(1);
    known.delete(1);
    expect(await service.validate(token)).toBeNull();
    expect(store.rows.size).toBe(0);
  });

  it('destroy ends the session and fires the hook', async () => {
    const { service, hooks } = setup();
    const seen: number[] = [];
    hooks.addAction('session:destroyed', ({ userId }) => void seen.push(userId));
    const { token } = await service.create(1);
    expect(await service.destroy(token)).toBe(true);
    expect(await service.validate(token)).toBeNull();
    expect(await service.destroy(token)).toBe(false);
    expect(seen).toEqual([1]);
  });

  it('destroyAllForUser and purgeExpired', async () => {
    const { service, store, advance } = setup(1_000);
    await service.create(1);
    await service.create(1);
    advance(500);
    await service.create(1);
    advance(600);
    expect(await service.purgeExpired()).toBe(2);
    expect(await service.destroyAllForUser(1)).toBe(1);
    expect(store.rows.size).toBe(0);
  });

  it('gives each session its own csrf token that only verifies for that session', async () => {
    const { service } = setup();
    const a = await service.create(1);
    const b = await service.create(1);
    expect(a.csrfToken).not.toBe(b.csrfToken);
    const idA = hashSessionToken(a.token);
    expect(csrfTokenFor(idA)).toBe(a.csrfToken);
    expect(verifyCsrfToken(idA, a.csrfToken)).toBe(true);
    expect(verifyCsrfToken(idA, b.csrfToken)).toBe(false);
    expect(verifyCsrfToken(idA, '')).toBe(false);
    expect(verifyCsrfToken(idA, undefined)).toBe(false);
    expect(verifyCsrfToken(idA, a.csrfToken.slice(1))).toBe(false);
  });
});
