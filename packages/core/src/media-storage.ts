import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { StorageAdapter } from './media.js';

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Throws unless `key` is a plain relative path of safe segments (no `..`, no leading dots or slashes). */
export function assertStorageKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.split('/').some((part) => part.includes('..'))) {
    throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  }
}

/** Stores files on local disk under `root`. Keys are validated so nothing escapes the folder. */
export function createLocalStorage(root: string): StorageAdapter {
  const base = resolve(root);
  const locate = (key: string): string => {
    assertStorageKey(key);
    const full = resolve(base, key);
    if (!full.startsWith(base + sep)) throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    return full;
  };
  return {
    async put(key, data) {
      const full = locate(key);
      await mkdir(dirname(full), { recursive: true });
      // 'wx': fail rather than overwrite an existing file.
      await writeFile(full, data, { flag: 'wx' });
    },
    async get(key) {
      try {
        return await readFile(locate(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async delete(key) {
      await rm(locate(key), { force: true });
    },
  };
}
