import { describe, expect, it, vi } from 'vitest';
import { HookRegistry } from './hooks.js';
import type { PasswordHasher } from './passwords.js';
import {
  createUsersService,
  DuplicateEmailError,
  UserNotFoundError,
  UserValidationError,
  type NewUserRecord,
  type UserPatchRecord,
  type UserRecord,
  type UsersStore,
} from './users.js';

/** Deterministic stand-in for Argon2 so tests are fast and need no native module. */
function fakeHasher(): PasswordHasher & { hashed: number; verified: number } {
  const h = {
    hashed: 0,
    verified: 0,
    async hash(password: string) {
      h.hashed++;
      return `fake$v2$${[...password].reverse().join('')}`;
    },
    async verify(hash: string, password: string) {
      h.verified++;
      const reversed = [...password].reverse().join('');
      return hash === `fake$v2$${reversed}` || hash === `legacy$${reversed}`;
    },
    needsRehash: (hash: string) => !hash.startsWith('fake$v2$'),
  };
  return h;
}

function memoryStore(): UsersStore & { rows: Map<number, UserRecord> } {
  const rows = new Map<number, UserRecord>();
  let next = 1;
  return {
    rows,
    async findById(id) {
      return rows.get(id);
    },
    async findByEmail(email) {
      return [...rows.values()].find((u) => u.email === email);
    },
    async list() {
      return [...rows.values()];
    },
    async insert(row: NewUserRecord) {
      if ([...rows.values()].some((u) => u.email === row.email)) throw new Error('UNIQUE');
      const now = new Date();
      const record = { id: next++, ...row, createdAt: now, updatedAt: now };
      rows.set(record.id, record);
      return record;
    },
    async update(id, patch: UserPatchRecord) {
      const existing = rows.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch, updatedAt: new Date() };
      rows.set(id, updated);
      return updated;
    },
    async delete(id) {
      return rows.delete(id);
    },
    async countByRole(role) {
      return [...rows.values()].filter((u) => u.role === role).length;
    },
  };
}

function setup() {
  const store = memoryStore();
  const hooks = new HookRegistry();
  const hasher = fakeHasher();
  const users = createUsersService({ store, hooks, hasher });
  return { store, hooks, hasher, users };
}

describe('UsersService.create', () => {
  it('stores a hash, normalises the email and never returns the hash', async () => {
    const { users, store } = setup();
    const user = await users.create({ email: '  Ann@Example.COM ', password: 'secret-pass' });
    expect(user).toMatchObject({ email: 'ann@example.com', role: 'subscriber', displayName: 'ann' });
    expect('passwordHash' in user).toBe(false);
    expect(store.rows.get(user.id)?.passwordHash).not.toContain('secret-pass');
  });

  it('rejects duplicate emails in any case', async () => {
    const { users } = setup();
    await users.create({ email: 'a@example.com', password: 'pw-123456' });
    await expect(users.create({ email: 'A@EXAMPLE.com', password: 'pw-123456' })).rejects.toBeInstanceOf(
      DuplicateEmailError,
    );
  });

  it('reports a duplicate when the unique index wins a race', async () => {
    const { users, store } = setup();
    const findByEmail = store.findByEmail.bind(store);
    let calls = 0;
    store.findByEmail = async (email) => (calls++ === 0 ? undefined : findByEmail(email));
    await users.create({ email: 'a@example.com', password: 'pw-123456' });
    calls = 0;
    await expect(users.create({ email: 'a@example.com', password: 'pw-123456' })).rejects.toBeInstanceOf(
      DuplicateEmailError,
    );
  });

  it('validates email, role, password and display name', async () => {
    const { users } = setup();
    await expect(users.create({ email: 'nope', password: 'pw' })).rejects.toBeInstanceOf(UserValidationError);
    await expect(
      users.create({ email: 'a@example.com', password: 'pw', role: 'root' as never }),
    ).rejects.toBeInstanceOf(UserValidationError);
    await expect(users.create({ email: 'a@example.com', password: '' })).rejects.toThrow(TypeError);
    await expect(
      users.create({ email: 'a@example.com', password: 'x'.repeat(2000) }),
    ).rejects.toThrow(RangeError);
    await expect(
      users.create({ email: 'a@example.com', password: 'pw', displayName: '   ' }),
    ).rejects.toBeInstanceOf(UserValidationError);
  });

  it('fires user:created', async () => {
    const { users, hooks } = setup();
    const seen = vi.fn();
    hooks.addAction('user:created', seen);
    const user = await users.create({ email: 'a@example.com', password: 'pw-123456' });
    expect(seen).toHaveBeenCalledWith(user);
  });
});

describe('UsersService.update', () => {
  it('changes fields, hashes a new password and fires user:updated', async () => {
    const { users, hooks, store } = setup();
    const seen = vi.fn();
    hooks.addAction('user:updated', seen);
    const user = await users.create({ email: 'a@example.com', password: 'old-password' });
    const before = store.rows.get(user.id)!.passwordHash;

    const updated = await users.update(user.id, {
      displayName: ' Ann ',
      role: 'editor',
      password: 'new-password',
    });
    expect(updated).toMatchObject({ displayName: 'Ann', role: 'editor' });
    expect(store.rows.get(user.id)!.passwordHash).not.toBe(before);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![1]).toMatchObject({ role: 'subscriber' });
    expect(await users.authenticate('a@example.com', 'new-password')).not.toBeNull();
    expect(await users.authenticate('a@example.com', 'old-password')).toBeNull();
  });

  it('is a no-op without changes and fires no hook', async () => {
    const { users, hooks } = setup();
    const seen = vi.fn();
    hooks.addAction('user:updated', seen);
    const user = await users.create({ email: 'a@example.com', password: 'pw-123456' });
    await users.update(user.id, { email: 'A@example.com', role: 'subscriber' });
    expect(seen).not.toHaveBeenCalled();
  });

  it('refuses an email that belongs to someone else, and unknown ids', async () => {
    const { users } = setup();
    await users.create({ email: 'a@example.com', password: 'pw-123456' });
    const b = await users.create({ email: 'b@example.com', password: 'pw-123456' });
    await expect(users.update(b.id, { email: 'a@example.com' })).rejects.toBeInstanceOf(
      DuplicateEmailError,
    );
    await expect(users.update(999, { displayName: 'x' })).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it('protects the last administrator from demotion and deletion', async () => {
    const { users } = setup();
    const admin = await users.create({ email: 'a@example.com', password: 'pw-123456', role: 'administrator' });
    await expect(users.update(admin.id, { role: 'editor' })).rejects.toBeInstanceOf(UserValidationError);
    await expect(users.delete(admin.id)).rejects.toBeInstanceOf(UserValidationError);

    const second = await users.create({ email: 'b@example.com', password: 'pw-123456', role: 'administrator' });
    await users.update(admin.id, { role: 'editor' });
    await expect(users.delete(second.id)).rejects.toBeInstanceOf(UserValidationError);
  });
});

describe('UsersService.delete', () => {
  it('removes a user and fires user:deleted; unknown ids return false', async () => {
    const { users, hooks } = setup();
    const seen = vi.fn();
    hooks.addAction('user:deleted', seen);
    const user = await users.create({ email: 'a@example.com', password: 'pw-123456' });
    expect(await users.delete(user.id)).toBe(true);
    expect(await users.findById(user.id)).toBeUndefined();
    expect(seen).toHaveBeenCalledWith(user);
    expect(await users.delete(user.id)).toBe(false);
  });
});

describe('UsersService.authenticate', () => {
  it('accepts the right password and rejects everything else the same way', async () => {
    const { users } = setup();
    await users.create({ email: 'a@example.com', password: 'right-password' });
    expect(await users.authenticate('A@Example.com', 'right-password')).toMatchObject({
      email: 'a@example.com',
    });
    expect(await users.authenticate('a@example.com', 'wrong')).toBeNull();
    expect(await users.authenticate('nobody@example.com', 'right-password')).toBeNull();
    expect(await users.authenticate('not-an-email', 'x')).toBeNull();
  });

  it('spends a hash verification on unknown users to hide whether they exist', async () => {
    const { users, hasher } = setup();
    const before = hasher.verified;
    await users.authenticate('nobody@example.com', 'whatever');
    expect(hasher.verified).toBe(before + 1);
  });

  it('upgrades an outdated hash after a successful login only', async () => {
    const { users, store } = setup();
    const user = await users.create({ email: 'a@example.com', password: 'pw-123456' });
    const legacy = `legacy$${[...'pw-123456'].reverse().join('')}`;
    store.rows.set(user.id, { ...store.rows.get(user.id)!, passwordHash: legacy });

    expect(await users.authenticate('a@example.com', 'wrong')).toBeNull();
    expect(store.rows.get(user.id)!.passwordHash).toBe(legacy);

    expect(await users.authenticate('a@example.com', 'pw-123456')).not.toBeNull();
    expect(store.rows.get(user.id)!.passwordHash.startsWith('fake$v2$')).toBe(true);
  });
});
