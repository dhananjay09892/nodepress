import { readZip } from '@nodepress/core';
import { describe, expect, it } from 'vitest';
import { writeZip } from './zip-writer.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe('writeZip', () => {
  it('writes an archive that the server reads back', () => {
    const zip = writeZip([
      { path: 'plugin.json', data: bytes('{"name":"a"}') },
      { path: 'lib/util.js', data: bytes('export const x = 1;\n'.repeat(50)) },
      { path: 'empty.txt', data: new Uint8Array() },
    ]);
    const files = readZip(zip);
    expect(files.map((f) => [f.path, f.data.byteLength])).toEqual([
      ['plugin.json', 12],
      ['lib/util.js', 1000],
      ['empty.txt', 0],
    ]);
    expect(text(files[0]!.data)).toBe('{"name":"a"}');
  });

  it('gives the same bytes for the same files', () => {
    const entries = [{ path: 'a.txt', data: bytes('hello') }];
    expect(Buffer.from(writeZip(entries)).equals(Buffer.from(writeZip(entries)))).toBe(true);
  });

  it('keeps unicode names', () => {
    const files = readZip(writeZip([{ path: 'zażółć.txt', data: bytes('x') }]));
    expect(files[0]?.path).toBe('zażółć.txt');
  });
});
