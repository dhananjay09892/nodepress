import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HookRegistry } from './hooks.js';
import type { User } from './users.js';

/** A session as stored. `id` is the SHA-256 of the cookie token; the token itself is never stored. */
export interface SessionRecord {
  id: string;
  userId: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface NewSessionRecord {
  id: string;
  userId: number;
  expiresAt: Date;
}

/** Storage behind the sessions service. `@nodepress/db` provides `createSessionsStore()`. */
export interface SessionsStore {
  insert(row: NewSessionRecord): Promise<SessionRecord>;
  findById(id: string): Promise<SessionRecord | undefined>;
  delete(id: string): Promise<boolean>;
  /** Remove every session of a user. Returns how many were removed. */
  deleteByUser(userId: number): Promise<number>;
  /** Remove sessions that expired at or before `now`. Returns how many were removed. */
  deleteExpired(now: Date): Promise<number>;
}

declare module './hooks.js' {
  interface ActionMap {
    'session:created': [info: { userId: number }];
    'session:destroyed': [info: { userId: number }];
  }
}

/** The part of the users service that sessions need. */
export interface SessionUsers {
  findById(id: number): Promise<User | undefined>;
}

export interface SessionsServiceOptions {
  store: SessionsStore;
  users: SessionUsers;
  hooks: HookRegistry;
  /** Session lifetime in milliseconds (default 14 days). */
  ttlMs?: number;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

export const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface CreatedSession {
  /** The secret to put in the cookie. Shown once; only its hash is stored. */
  token: string;
  expiresAt: Date;
  csrfToken: string;
}

export interface ActiveSession {
  user: User;
  session: SessionRecord;
  csrfToken: string;
}

/** 32 random bytes as base64url is always 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * CSRF token for a session. Derived from the stored session id, so it needs no extra storage
 * and a page on another origin can neither read nor guess it.
 */
export function csrfTokenFor(sessionId: string): string {
  return createHmac('sha256', sessionId).update('nodepress:csrf:v1').digest('base64url');
}

export function verifyCsrfToken(sessionId: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const expected = Buffer.from(csrfTokenFor(sessionId));
  const given = Buffer.from(candidate);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export class SessionsService {
  readonly #store: SessionsStore;
  readonly #users: SessionUsers;
  readonly #hooks: HookRegistry;
  readonly #ttlMs: number;
  readonly #now: () => Date;

  constructor(options: SessionsServiceOptions) {
    this.#store = options.store;
    this.#users = options.users;
    this.#hooks = options.hooks;
    this.#ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#now = options.now ?? (() => new Date());
    if (!(this.#ttlMs > 0)) throw new RangeError('ttlMs must be positive');
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Start a session for a user who has already proven who they are. */
  async create(userId: number): Promise<CreatedSession> {
    const token = randomBytes(32).toString('base64url');
    const id = hashSessionToken(token);
    const expiresAt = new Date(this.#now().getTime() + this.#ttlMs);
    await this.#store.insert({ id, userId, expiresAt });
    await this.#hooks.doAction('session:created', { userId });
    return { token, expiresAt, csrfToken: csrfTokenFor(id) };
  }

  /** The user behind a cookie token, or `null` if it is unknown, expired or its user is gone. */
  async validate(token: string | undefined): Promise<ActiveSession | null> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const id = hashSessionToken(token);
    const session = await this.#store.findById(id);
    if (!session) return null;
    if (session.expiresAt.getTime() <= this.#now().getTime()) {
      await this.#store.delete(id);
      return null;
    }
    const user = await this.#users.findById(session.userId);
    if (!user) {
      await this.#store.delete(id);
      return null;
    }
    return { user, session, csrfToken: csrfTokenFor(id) };
  }

  /** End the session behind a token. Returns false if there was none. */
  async destroy(token: string | undefined): Promise<boolean> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
    const id = hashSessionToken(token);
    const session = await this.#store.findById(id);
    if (!session) return false;
    const removed = await this.#store.delete(id);
    if (removed) await this.#hooks.doAction('session:destroyed', { userId: session.userId });
    return removed;
  }

  /** Sign a user out everywhere, e.g. after a password change. */
  async destroyAllForUser(userId: number): Promise<number> {
    return this.#store.deleteByUser(userId);
  }

  /** Delete expired sessions. Meant to run now and then. */
  async purgeExpired(): Promise<number> {
    return this.#store.deleteExpired(this.#now());
  }
}

export function createSessionsService(options: SessionsServiceOptions): SessionsService {
  return new SessionsService(options);
}
