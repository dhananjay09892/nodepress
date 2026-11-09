import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertStorageKey, createLocalStorage } from './media-storage.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'np-media-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('local storage', () => {
  it('writes, reads and deletes files, creating folders', async () => {
    const storage = createLocalStorage(root);
    await storage.put('uploads/2026/11/a-1.png', Buffer.from('abc'), 'image/png');
    expect((await readFile(join(root, 'uploads/2026/11/a-1.png'))).toString()).toBe('abc');
    expect((await storage.get('uploads/2026/11/a-1.png'))?.toString()).toBe('abc');
    await storage.delete('uploads/2026/11/a-1.png');
    expect(await storage.get('uploads/2026/11/a-1.png')).toBeUndefined();
    await storage.delete('uploads/2026/11/a-1.png'); // already gone: no error
  });

  it('never overwrites an existing file', async () => {
    const storage = createLocalStorage(root);
    await storage.put('uploads/a.png', Buffer.from('one'), 'image/png');
    await expect(storage.put('uploads/a.png', Buffer.from('two'), 'image/png')).rejects.toThrow();
    expect((await storage.get('uploads/a.png'))?.toString()).toBe('one');
  });

  it.each([
    '../escape.txt',
    'uploads/../../escape.txt',
    '/etc/passwd',
    'uploads//a.png',
    'uploads/.hidden',
    'uploads\\a.png',
    'uploads/a\0.png',
    '',
    'uploads/..',
  ])('rejects the key %j', async (key) => {
    const storage = createLocalStorage(root);
    expect(() => assertStorageKey(key)).toThrow();
    await expect(storage.put(key, Buffer.from('x'), 'text/plain')).rejects.toThrow();
    await expect(storage.get(key)).rejects.toThrow();
    await expect(storage.delete(key)).rejects.toThrow();
    await expect(stat(join(root, '..', 'escape.txt'))).rejects.toThrow();
  });
});
