import { describe, expect, it } from 'vitest';
import {
  ApiTokenValidationError,
  createApiTokensService,
  hashApiToken,
  LAST_USED_RESOLUTION_MS,
  type ApiTokenRecord,
  type ApiTokensStore,
} from './api-tokens.js';
import { HookRegistry } from './hooks.js';
import type { User } from './users.js';

function memoryStore(): ApiTokensStore & {
  rows: Map<number, ApiTokenRecord>;
  touches: number;
  failTouch: boolean;
} {
  const rows = new Map<number, ApiTokenRecord>();
  let nextId = 1;
  const store = {
    rows,
    touches: 0,
    failTouch: false,
    async insert(row: Parameters<ApiTokensStore['insert']>[0]) {
      const rec: ApiTokenRecord = {
        id: nextId++,
        ...row,
        lastUsedAt: null,
        createdAt: new Date(),
      };
      rows.set(rec.id, rec);
      return rec;
    },
    async findByHash(hash: string) {
      return [...rows.values()].find((r) => r.tokenHash === hash);
    },
    async listByUser(userId: number) {
      return [...rows.values()].filter((r) => r.userId === userId);
    },
    async countByUser(userId: number) {
      return [...rows.values()].filter((r) => r.userId === userId).length;
    },
    async delete(id: number, userId: number) {
      const rec = rows.get(id);
      return rec?.userId === userId ? rows.delete(id) : false;
    },
    async deleteByUser(userId: number) {
      let n = 0;
      for (const [id, r] of rows) if (r.userId === userId && rows.delete(id)) n++;
      return n;
    },
    async touch(id: number, at: Date) {
      store.touches++;
      if (store.failTouch) throw new Error('db down');
      const rec = rows.get(id);
      if (rec) rec.lastUsedAt = at;
    },
  };
  return store;
}

const alice: User = {
  id: 1,
  email: 'alice@example.com',
  displayName: 'Alice',
  role: 'administrator',
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function setup(maxPerUser?: number) {
  const store = memoryStore();
  const hooks = new HookRegistry();
  const known = new Map<number, User>([[1, alice]]);
  let t = 1_000_000;
  const service = createApiTokensService({
    store,
    hooks,
    users: { findById: async (id) => known.get(id) },
    now: () => new Date(t),
    ...(maxPerUser ? { maxPerUser } : {}),
  });
  return { service, store, hooks, known, advance: (ms: number) => void (t += ms), now: () => t };
}

describe('API tokens service', () => {
  it('creates a token whose secret is shown once and only its hash is stored', async () => {
    const { service, store } = setup();
    const { token, record } = await service.create(1, { name: '  CI deploy ' });
    expect(token).toMatch(/^npt_[A-Za-z0-9_-]{43}$/);
    expect(record.name).toBe('CI deploy');
    expect(record).not.toHaveProperty('tokenHash');
    const stored = store.rows.get(record.id)!;
    expect(stored.tokenHash).toBe(hashApiToken(token));
    expect(JSON.stringify([...store.rows.values()])).not.toContain(token);
  });

  it('generates distinct secrets', async () => {
    const { service } = setup();
    const a = await service.create(1, { name: 'a' });
    const b = await service.create(1, { name: 'b' });
    expect(a.token).not.toBe(b.token);
  });

  it('validates name, expiry and the per-user limit', async () => {
    const { service } = setup(2);
    await expect(service.create(1, { name: '   ' })).rejects.toBeInstanceOf(
      ApiTokenValidationError,
    );
    await expect(service.create(1, { name: 'x'.repeat(101) })).rejects.toBeInstanceOf(
      ApiTokenValidationError,
    );
    await expect(service.create(1, { name: 'a', expiresAt: new Date(0) })).rejects.toThrow(
      /future/,
    );
    await expect(
      service.create(1, { name: 'a', expiresAt: new Date(Number.NaN) }),
    ).rejects.toThrow(/future/);
    await service.create(1, { name: 'one' });
    await service.create(1, { name: 'two' });
    await expect(service.create(1, { name: 'three' })).rejects.toThrow(/at most 2/);
  });

  it('authenticates a valid token and returns its user', async () => {
    const { service } = setup();
    const { token, record } = await service.create(1, { name: 'cli' });
    const result = await service.authenticate(token);
    expect(result?.user.id).toBe(1);
    expect(result?.token.id).toBe(record.id);
    expect(result?.token).not.toHaveProperty('tokenHash');
  });

  it('rejects missing, malformed, unknown and tampered tokens', async () => {
    const { service } = setup();
    const { token } = await service.create(1, { name: 'cli' });
    expect(await service.authenticate(undefined)).toBeNull();
    expect(await service.authenticate('')).toBeNull();
    expect(await service.authenticate('npt_short')).toBeNull();
    expect(await service.authenticate(`npt_${'a'.repeat(43)}`)).toBeNull();
    expect(await service.authenticate(token.slice(4))).toBeNull(); // prefix missing
    expect(await service.authenticate(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
  });

  it('stops working once revoked, and fires the hook', async () => {
    const { service, hooks } = setup();
    const seen: number[] = [];
    hooks.addAction('apitoken:revoked', ({ tokenId }) => void seen.push(tokenId));
    const { token, record } = await service.create(1, { name: 'cli' });
    expect(await service.revoke(1, record.id)).toBe(true);
    expect(await service.authenticate(token)).toBeNull();
    expect(await service.revoke(1, record.id)).toBe(false);
    expect(seen).toEqual([record.id]);
  });

  it("cannot revoke another user's token", async () => {
    const { service } = setup();
    const { token, record } = await service.create(1, { name: 'cli' });
    expect(await service.revoke(2, record.id)).toBe(false);
    expect(await service.authenticate(token)).not.toBeNull();
  });

  it('revokeAllForUser removes every token of that user only', async () => {
    const { service } = setup();
    const a = await service.create(1, { name: 'a' });
    await service.create(1, { name: 'b' });
    const other = await service.create(2, { name: 'c' });
    expect(await service.revokeAllForUser(1)).toBe(2);
    expect(await service.authenticate(a.token)).toBeNull();
    expect((await service.list(2)).map((t) => t.id)).toEqual([other.record.id]);
  });

  it('rejects expired tokens', async () => {
    const { service, advance, now } = setup();
    const { token } = await service.create(1, { name: 'short', expiresAt: new Date(now() + 1_000) });
    expect(await service.authenticate(token)).not.toBeNull();
    advance(1_000);
    expect(await service.authenticate(token)).toBeNull();
  });

  it('rejects tokens whose user was deleted', async () => {
    const { service, known } = setup();
    const { token } = await service.create(1, { name: 'cli' });
    known.delete(1);
    expect(await service.authenticate(token)).toBeNull();
  });

  it('lists a user\'s tokens without hashes', async () => {
    const { service } = setup();
    await service.create(1, { name: 'a' });
    await service.create(1, { name: 'b' });
    await service.create(2, { name: 'c' });
    const list = await service.list(1);
    expect(list.map((t) => t.name)).toEqual(['a', 'b']);
    for (const t of list) expect(t).not.toHaveProperty('tokenHash');
  });

  it('updates lastUsedAt at most once per resolution window', async () => {
    const { service, store, advance } = setup();
    const { token, record } = await service.create(1, { name: 'cli' });
    await service.authenticate(token);
    await service.authenticate(token);
    expect(store.touches).toBe(1);
    expect(store.rows.get(record.id)!.lastUsedAt).not.toBeNull();
    advance(LAST_USED_RESOLUTION_MS);
    await service.authenticate(token);
    expect(store.touches).toBe(2);
  });

  it('still authenticates when the lastUsedAt write fails', async () => {
    const { service, store } = setup();
    const { token } = await service.create(1, { name: 'cli' });
    store.failTouch = true;
    expect(await service.authenticate(token)).not.toBeNull();
  });

  it('fires apitoken:created', async () => {
    const { service, hooks } = setup();
    const seen: number[] = [];
    hooks.addAction('apitoken:created', ({ userId }) => void seen.push(userId));
    await service.create(1, { name: 'cli' });
    expect(seen).toEqual([1]);
  });
});
