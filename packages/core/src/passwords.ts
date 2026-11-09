/** Hashes and verifies passwords. Hashes are self-describing strings safe to store. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** Returns false (never throws) for a wrong password or a malformed hash. */
  verify(hash: string, password: string): Promise<boolean>;
  /** True if the hash was made with weaker parameters than the current ones. */
  needsRehash?(hash: string): boolean;
}

/** OWASP-recommended Argon2id minimum: 19 MiB memory, 2 iterations, 1 lane. */
export const ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const MAX_PASSWORD_LENGTH = 1024;

interface Argon2Module {
  hash(
    password: string,
    options: { memoryCost: number; timeCost: number; parallelism: number; algorithm: number },
  ): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

const ARGON2_PACKAGE: string = '@node-rs/argon2';

/** Argon2id from `@node-rs/argon2` (prebuilt binaries, no compiler needed), loaded on first use. */
export function createArgon2Hasher(): PasswordHasher {
  let mod: Promise<Argon2Module> | undefined;
  const load = (): Promise<Argon2Module> =>
    (mod ??= import(ARGON2_PACKAGE) as Promise<Argon2Module>);
  const prefix = `$argon2id$v=19$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}$`;

  return {
    async hash(password) {
      assertPassword(password);
      const argon2 = await load();
      // algorithm 2 = Argon2id
      return argon2.hash(password, { ...ARGON2_PARAMS, algorithm: 2 });
    },
    async verify(hash, password) {
      if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
      try {
        return await (await load()).verify(hash, password);
      } catch {
        return false;
      }
    },
    needsRehash: (hash) => !hash.startsWith(prefix),
  };
}

export function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('Password must be a non-empty string');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new RangeError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}
