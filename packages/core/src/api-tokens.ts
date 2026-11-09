import { createHash, randomBytes } from 'node:crypto';
import type { HookRegistry } from './hooks.js';
import type { User } from './users.js';

/** An API token as stored. `tokenHash` is the SHA-256 of the secret; the secret is never stored. */
export interface ApiTokenRecord {
  id: number;
  userId: number;
  name: string;
  tokenHash: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface NewApiTokenRecord {
  userId: number;
  name: string;
  tokenHash: string;
  expiresAt: Date | null;
}

/** A token as shown to its owner: everything except the hash. */
export type ApiToken = Omit<ApiTokenRecord, 'tokenHash'>;

/** Storage behind the API tokens service. `@nodepress/db` provides `createApiTokensStore()`. */
export interface ApiTokensStore {
  insert(row: NewApiTokenRecord): Promise<ApiTokenRecord>;
  findByHash(tokenHash: string): Promise<ApiTokenRecord | undefined>;
  listByUser(userId: number): Promise<ApiTokenRecord[]>;
  countByUser(userId: number): Promise<number>;
  /** Delete a token only if it belongs to `userId`. Returns false if there was no such token. */
  delete(id: number, userId: number): Promise<boolean>;
  deleteByUser(userId: number): Promise<number>;
  touch(id: number, at: Date): Promise<void>;
}

declare module './hooks.js' {
  interface ActionMap {
    'apitoken:created': [info: { userId: number; tokenId: number }];
    'apitoken:revoked': [info: { userId: number; tokenId: number }];
  }
}

/** The part of the users service that API tokens need. */
export interface ApiTokenUsers {
  findById(id: number): Promise<User | undefined>;
}

export interface ApiTokensServiceOptions {
  store: ApiTokensStore;
  users: ApiTokenUsers;
  hooks: HookRegistry;
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Most tokens one user may hold (default 50). */
  maxPerUser?: number;
}

export class ApiTokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiTokenValidationError';
  }
}

export interface CreateApiTokenInput {
  name: string;
  /** When the token stops working. Omit for a token that never expires. */
  expiresAt?: Date | null;
}

export interface CreatedApiToken {
  /** The secret to give to the client. Shown once; only its hash is stored. */
  token: string;
  record: ApiToken;
}

export interface AuthenticatedApiToken {
  user: User;
  token: ApiToken;
}

export const API_TOKEN_PREFIX = 'npt_';
export const DEFAULT_MAX_TOKENS_PER_USER = 50;
export const MAX_TOKEN_NAME_LENGTH = 100;
/** `lastUsedAt` is refreshed at most this often, so reads do not turn into writes. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** Prefix plus 32 random bytes as base64url (always 43 characters). */
const TOKEN_PATTERN = /^npt_[A-Za-z0-9_-]{43}$/;

/** SHA-256 is enough here because the secret is 256 bits of randomness, not a human password. */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toPublic(record: ApiTokenRecord): ApiToken {
  return {
    id: record.id,
    userId: record.userId,
    name: record.name,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  };
}

export class ApiTokensService {
  readonly #store: ApiTokensStore;
  readonly #users: ApiTokenUsers;
  readonly #hooks: HookRegistry;
  readonly #now: () => Date;
  readonly #maxPerUser: number;

  constructor(options: ApiTokensServiceOptions) {
    this.#store = options.store;
    this.#users = options.users;
    this.#hooks = options.hooks;
    this.#now = options.now ?? (() => new Date());
    this.#maxPerUser = options.maxPerUser ?? DEFAULT_MAX_TOKENS_PER_USER;
  }

  async create(userId: number, input: CreateApiTokenInput): Promise<CreatedApiToken> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length === 0 || name.length > MAX_TOKEN_NAME_LENGTH) {
      throw new ApiTokenValidationError(`name must be 1-${MAX_TOKEN_NAME_LENGTH} characters`);
    }
    const expiresAt = input.expiresAt ?? null;
    if (
      expiresAt !== null &&
      (!(expiresAt instanceof Date) ||
        Number.isNaN(expiresAt.getTime()) ||
        expiresAt.getTime() <= this.#now().getTime())
    ) {
      throw new ApiTokenValidationError('expiresAt must be a date in the future');
    }
    if ((await this.#store.countByUser(userId)) >= this.#maxPerUser) {
      throw new ApiTokenValidationError(`a user can hold at most ${this.#maxPerUser} tokens`);
    }

    const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const record = await this.#store.insert({
      userId,
      name,
      tokenHash: hashApiToken(token),
      expiresAt,
    });
    await this.#hooks.doAction('apitoken:created', { userId, tokenId: record.id });
    return { token, record: toPublic(record) };
  }

  async list(userId: number): Promise<ApiToken[]> {
    return (await this.#store.listByUser(userId)).map(toPublic);
  }

  /** Revoke one of a user's tokens. Returns false if it does not exist or belongs to someone else. */
  async revoke(userId: number, tokenId: number): Promise<boolean> {
    const removed = await this.#store.delete(tokenId, userId);
    if (removed) await this.#hooks.doAction('apitoken:revoked', { userId, tokenId });
    return removed;
  }

  /** Revoke every token of a user, e.g. when the account is locked down. */
  async revokeAllForUser(userId: number): Promise<number> {
    return this.#store.deleteByUser(userId);
  }

  /** The user behind a bearer token, or `null` if it is malformed, unknown, expired or orphaned. */
  async authenticate(token: string | undefined): Promise<AuthenticatedApiToken | null> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const record = await this.#store.findByHash(hashApiToken(token));
    if (!record) return null;
    const now = this.#now();
    if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) return null;
    const user = await this.#users.findById(record.userId);
    if (!user) return null;

    if (
      !record.lastUsedAt ||
      now.getTime() - record.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS
    ) {
      // Bookkeeping only: a failed write must not turn a valid token into a failed request.
      await this.#store.touch(record.id, now).catch(() => undefined);
    }
    return { user, token: toPublic(record) };
  }
}

export function createApiTokensService(options: ApiTokensServiceOptions): ApiTokensService {
  return new ApiTokensService(options);
}
