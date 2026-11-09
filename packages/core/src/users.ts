import { isRole, type RoleName } from './capabilities.js';
import type { HookRegistry } from './hooks.js';
import { assertPassword, type PasswordHasher } from './passwords.js';

/** A user as stored. `passwordHash` never leaves the service. */
export interface UserRecord {
  id: number;
  email: string;
  passwordHash: string;
  displayName: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A user as the rest of the system sees it. */
export type User = Omit<UserRecord, 'passwordHash'>;

export interface NewUserRecord {
  email: string;
  passwordHash: string;
  displayName: string;
  role: string;
}

export interface UserPatchRecord {
  email?: string;
  passwordHash?: string;
  displayName?: string;
  role?: string;
}

/** Storage behind the users service. `@nodepress/db` provides `createUsersStore()`. */
export interface UsersStore {
  findById(id: number): Promise<UserRecord | undefined>;
  /** `email` is already normalised (trimmed, lower-cased). */
  findByEmail(email: string): Promise<UserRecord | undefined>;
  list(): Promise<UserRecord[]>;
  /** Rejects when the email is taken (unique index); the service reports it as a duplicate. */
  insert(row: NewUserRecord): Promise<UserRecord>;
  /** Returns the updated row, or undefined if the user does not exist. */
  update(id: number, patch: UserPatchRecord): Promise<UserRecord | undefined>;
  delete(id: number): Promise<boolean>;
  countByRole(role: string): Promise<number>;
}

declare module './hooks.js' {
  interface ActionMap {
    'user:created': [user: User];
    'user:updated': [user: User, previous: User];
    'user:deleted': [user: User];
  }
}

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`A user with the email "${email}" already exists`);
    this.name = 'DuplicateEmailError';
  }
}

export class UserNotFoundError extends Error {
  constructor(id: number) {
    super(`User ${id} does not exist`);
    this.name = 'UserNotFoundError';
  }
}

export class UserValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserValidationError';
  }
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName?: string;
  role?: RoleName;
}

export interface UpdateUserInput {
  email?: string;
  password?: string;
  displayName?: string;
  role?: RoleName;
}

export interface UsersServiceOptions {
  store: UsersStore;
  hooks: HookRegistry;
  hasher: PasswordHasher;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  if (typeof email !== 'string') throw new UserValidationError('Email must be a string');
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new UserValidationError('Email address is not valid');
  }
  return normalized;
}

function assertRole(role: string): asserts role is RoleName {
  if (!isRole(role)) throw new UserValidationError(`Unknown role "${role}"`);
}

function toUser(record: UserRecord): User {
  const { passwordHash: _omit, ...user } = record;
  return user;
}

/**
 * Create, read, update and delete users, and check credentials.
 *
 * - Passwords are hashed with the injected {@link PasswordHasher} (Argon2id in production);
 *   the hash is never returned to callers.
 * - The last administrator cannot be deleted or demoted.
 * - `authenticate()` spends the same time for unknown emails as for wrong passwords.
 */
export class UsersService {
  readonly #store: UsersStore;
  readonly #hooks: HookRegistry;
  readonly #hasher: PasswordHasher;
  #dummyHash: Promise<string> | undefined;

  constructor(options: UsersServiceOptions) {
    this.#store = options.store;
    this.#hooks = options.hooks;
    this.#hasher = options.hasher;
  }

  async create(input: CreateUserInput): Promise<User> {
    const email = normalizeEmail(input.email);
    const role = input.role ?? 'subscriber';
    assertRole(role);
    assertPassword(input.password);
    const displayName = (input.displayName ?? email.split('@')[0] ?? email).trim();
    if (displayName.length === 0) throw new UserValidationError('Display name cannot be empty');

    if (await this.#store.findByEmail(email)) throw new DuplicateEmailError(email);
    const passwordHash = await this.#hasher.hash(input.password);
    let record: UserRecord;
    try {
      record = await this.#store.insert({ email, passwordHash, displayName, role });
    } catch (error) {
      // Two requests can pass the check above together; the unique index decides.
      if (await this.#store.findByEmail(email)) throw new DuplicateEmailError(email);
      throw error;
    }
    const user = toUser(record);
    await this.#hooks.doAction('user:created', user);
    return user;
  }

  async findById(id: number): Promise<User | undefined> {
    const record = await this.#store.findById(id);
    return record && toUser(record);
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const record = await this.#store.findByEmail(normalizeEmail(email));
    return record && toUser(record);
  }

  async list(): Promise<User[]> {
    return (await this.#store.list()).map(toUser);
  }

  async update(id: number, input: UpdateUserInput): Promise<User> {
    const existing = await this.#store.findById(id);
    if (!existing) throw new UserNotFoundError(id);

    const patch: UserPatchRecord = {};
    if (input.email !== undefined) {
      const email = normalizeEmail(input.email);
      if (email !== existing.email) {
        const taken = await this.#store.findByEmail(email);
        if (taken && taken.id !== id) throw new DuplicateEmailError(email);
        patch.email = email;
      }
    }
    if (input.displayName !== undefined) {
      const displayName = input.displayName.trim();
      if (displayName.length === 0) throw new UserValidationError('Display name cannot be empty');
      patch.displayName = displayName;
    }
    if (input.role !== undefined) {
      assertRole(input.role);
      if (input.role !== existing.role) {
        if (existing.role === 'administrator') await this.#assertNotLastAdmin();
        patch.role = input.role;
      }
    }
    if (input.password !== undefined) {
      assertPassword(input.password);
      patch.passwordHash = await this.#hasher.hash(input.password);
    }
    if (Object.keys(patch).length === 0) return toUser(existing);

    const updated = await this.#store.update(id, patch);
    if (!updated) throw new UserNotFoundError(id);
    const user = toUser(updated);
    await this.#hooks.doAction('user:updated', user, toUser(existing));
    return user;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.#store.findById(id);
    if (!existing) return false;
    if (existing.role === 'administrator') await this.#assertNotLastAdmin();
    const removed = await this.#store.delete(id);
    if (removed) await this.#hooks.doAction('user:deleted', toUser(existing));
    return removed;
  }

  /**
   * Check an email and password. Returns the user, or `null` for any failure (unknown email,
   * wrong password) so callers cannot tell which. A hash made with outdated parameters is
   * upgraded after a successful login.
   */
  async authenticate(email: string, password: string): Promise<User | null> {
    let normalized: string;
    try {
      normalized = normalizeEmail(email);
    } catch {
      await this.#burn(password);
      return null;
    }
    const record = await this.#store.findByEmail(normalized);
    if (!record) {
      await this.#burn(password);
      return null;
    }
    if (!(await this.#hasher.verify(record.passwordHash, password))) return null;

    if (this.#hasher.needsRehash?.(record.passwordHash)) {
      try {
        await this.#store.update(record.id, { passwordHash: await this.#hasher.hash(password) });
      } catch {
        // A failed upgrade must not block a valid login.
      }
    }
    return toUser(record);
  }

  async #assertNotLastAdmin(): Promise<void> {
    if ((await this.#store.countByRole('administrator')) <= 1) {
      throw new UserValidationError('The last administrator cannot be removed or demoted');
    }
  }

  /** Verify against a throwaway hash so unknown users cost the same time as wrong passwords. */
  async #burn(password: string): Promise<void> {
    this.#dummyHash ??= this.#hasher.hash('nodepress-timing-equaliser');
    await this.#hasher.verify(await this.#dummyHash, typeof password === 'string' ? password : '');
  }
}

export function createUsersService(options: UsersServiceOptions): UsersService {
  return new UsersService(options);
}
