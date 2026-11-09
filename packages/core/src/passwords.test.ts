import { describe, expect, it } from 'vitest';
import { ARGON2_PARAMS, assertPassword, createArgon2Hasher } from './passwords.js';

let argon2Available = true;
try {
  await import('@node-rs/argon2' as string);
} catch {
  argon2Available = false;
}

describe('assertPassword', () => {
  it('rejects empty, non-string and oversized passwords', () => {
    expect(() => assertPassword('')).toThrow(TypeError);
    expect(() => assertPassword(5 as never)).toThrow(TypeError);
    expect(() => assertPassword('x'.repeat(1025))).toThrow(RangeError);
    expect(() => assertPassword('ok')).not.toThrow();
  });
});

describe.skipIf(!argon2Available)('Argon2 hasher', () => {
  const hasher = createArgon2Hasher();

  it('produces salted Argon2id hashes with the configured cost', async () => {
    const a = await hasher.hash('correct horse');
    const b = await hasher.hash('correct horse');
    expect(a).not.toBe(b);
    expect(a.startsWith(`$argon2id$v=19$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=1$`)).toBe(true);
    expect(a).not.toContain('correct horse');
    expect(hasher.needsRehash?.(a)).toBe(false);
  });

  it('verifies the right password and rejects wrong ones without throwing', async () => {
    const hash = await hasher.hash('correct horse');
    expect(await hasher.verify(hash, 'correct horse')).toBe(true);
    expect(await hasher.verify(hash, 'wrong')).toBe(false);
    expect(await hasher.verify('not-a-hash', 'correct horse')).toBe(false);
    expect(await hasher.verify(hash, 'x'.repeat(5000))).toBe(false);
  });

  it('flags hashes with weaker parameters for rehash', () => {
    expect(hasher.needsRehash?.('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
  });
});
