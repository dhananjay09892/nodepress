export interface RateLimiterOptions {
  /** Failures allowed per key within one window before the key is blocked. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Upper bound on tracked keys, so a flood of distinct keys cannot grow memory without limit. */
  maxKeys?: number;
}

export interface RateLimitStatus {
  allowed: boolean;
  /** Failures still allowed in this window. */
  remaining: number;
  /** When blocked, how long until the key is allowed again. 0 when allowed. */
  retryAfterMs: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window failure counter kept in memory. Call `check()` before the protected action,
 * `fail()` when it fails and `reset()` when it succeeds.
 *
 * Per-process only: with several server instances each one counts separately.
 */
export class RateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #entries = new Map<string, Entry>();

  constructor(options: RateLimiterOptions) {
    if (!(options.max >= 1)) throw new RangeError('max must be at least 1');
    if (!(options.windowMs > 0)) throw new RangeError('windowMs must be positive');
    this.#max = Math.floor(options.max);
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  check(key: string): RateLimitStatus {
    const entry = this.#live(key);
    const count = entry?.count ?? 0;
    if (entry && count >= this.#max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, entry.resetAt - this.#now()),
      };
    }
    return { allowed: true, remaining: this.#max - count, retryAfterMs: 0 };
  }

  /** Record a failure and return the status afterwards. */
  fail(key: string): RateLimitStatus {
    const now = this.#now();
    let entry = this.#live(key);
    if (!entry) {
      this.#makeRoom();
      entry = { count: 0, resetAt: now + this.#windowMs };
      this.#entries.set(key, entry);
    }
    entry.count++;
    return this.check(key);
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }

  #live(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry && entry.resetAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  #makeRoom(): void {
    if (this.#entries.size < this.#maxKeys) return;
    const now = this.#now();
    for (const [key, entry] of this.#entries) if (entry.resetAt <= now) this.#entries.delete(key);
    // Still full: drop the oldest entries (Map keeps insertion order).
    for (const key of this.#entries.keys()) {
      if (this.#entries.size < this.#maxKeys) break;
      this.#entries.delete(key);
    }
  }
}
