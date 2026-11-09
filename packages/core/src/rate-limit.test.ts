import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.js';

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('RateLimiter', () => {
  it('allows failures up to max, then blocks with a retry time', () => {
    const c = clock();
    const rl = new RateLimiter({ max: 3, windowMs: 60_000, now: c.now });
    expect(rl.check('k')).toEqual({ allowed: true, remaining: 3, retryAfterMs: 0 });
    rl.fail('k');
    rl.fail('k');
    expect(rl.check('k').allowed).toBe(true);
    const last = rl.fail('k');
    expect(last.allowed).toBe(false);
    c.advance(10_000);
    expect(rl.check('k')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 50_000 });
  });

  it('unblocks when the window passes', () => {
    const c = clock();
    const rl = new RateLimiter({ max: 1, windowMs: 1_000, now: c.now });
    rl.fail('k');
    expect(rl.check('k').allowed).toBe(false);
    c.advance(1_000);
    expect(rl.check('k').allowed).toBe(true);
    expect(rl.size).toBe(0);
  });

  it('tracks keys independently and reset clears one', () => {
    const rl = new RateLimiter({ max: 1, windowMs: 1_000, now: clock().now });
    rl.fail('a');
    expect(rl.check('a').allowed).toBe(false);
    expect(rl.check('b').allowed).toBe(true);
    rl.reset('a');
    expect(rl.check('a').allowed).toBe(true);
  });

  it('bounds memory by dropping expired, then oldest, keys', () => {
    const c = clock();
    const rl = new RateLimiter({ max: 5, windowMs: 1_000, maxKeys: 3, now: c.now });
    rl.fail('a');
    rl.fail('b');
    c.advance(1_000);
    rl.fail('c');
    rl.fail('d');
    expect(rl.size).toBeLessThanOrEqual(3);
    rl.fail('e');
    rl.fail('f');
    expect(rl.size).toBeLessThanOrEqual(3);
    expect(rl.check('f').remaining).toBe(4);
  });

  it('rejects invalid options', () => {
    expect(() => new RateLimiter({ max: 0, windowMs: 1 })).toThrow(RangeError);
    expect(() => new RateLimiter({ max: 1, windowMs: 0 })).toThrow(RangeError);
  });
});
