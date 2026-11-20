import { describe, expect, it } from 'vitest';
import { createTestZip } from './testing/zip-builder.js';
import { readZip, safeZipPath, ZipError } from './zip.js';

const text = (data: Uint8Array): string => new TextDecoder().decode(data);

describe('readZip', () => {
  it('reads stored and deflated files and skips folders', () => {
    const zip = createTestZip([
      { name: 'a/', data: '' },
      { name: 'a/one.txt', data: 'hello hello hello hello' },
      { name: 'two.txt', data: 'stored', deflate: false },
    ]);
    const files = readZip(zip);
    expect(files.map((f) => [f.path, text(f.data)])).toEqual([
      ['a/one.txt', 'hello hello hello hello'],
      ['two.txt', 'stored'],
    ]);
  });

  it('rejects data that is not a zip', () => {
    expect(() => readZip(new Uint8Array(10))).toThrow(ZipError);
    expect(() => readZip(new TextEncoder().encode('x'.repeat(100)))).toThrow(/not a zip/);
  });

  it.each([
    ['../evil.txt', /unsafe/],
    ['a/../../evil.txt', /unsafe/],
    ['/etc/passwd', /absolute/],
    ['C:/x.txt', /absolute/],
    ['a\\b.txt', /unsafe/],
  ])('rejects the path %s', (name, message) => {
    expect(() => readZip(createTestZip([{ name, data: 'x' }]))).toThrow(message);
  });

  it('rejects symbolic links, encryption and duplicate names', () => {
    expect(() => readZip(createTestZip([{ name: 'l', data: '/etc', mode: 0o120777 }]))).toThrow(
      /symbolic link/,
    );
    expect(() => readZip(createTestZip([{ name: 'e', data: 'x', encrypted: true }]))).toThrow(
      /encrypted/,
    );
    expect(() =>
      readZip(
        createTestZip([
          { name: 'd', data: '1' },
          { name: './d', data: '2' },
        ]),
      ),
    ).toThrow(/twice/);
  });

  it('enforces limits, including a deflated file that claims to be small', () => {
    const big = createTestZip([{ name: 'big', data: 'x'.repeat(1000) }]);
    const limits = { maxEntries: 10, maxFileBytes: 500, maxTotalBytes: 10_000 };
    expect(() => readZip(big, limits)).toThrow(/too large/);
    expect(() =>
      readZip(
        createTestZip([
          { name: 'a', data: 'x' },
          { name: 'b', data: 'y' },
        ]),
        { ...limits, maxEntries: 1 },
      ),
    ).toThrow(/too many/);
    expect(() =>
      readZip(
        createTestZip([
          { name: 'a', data: 'x'.repeat(400) },
          { name: 'b', data: 'y'.repeat(400) },
        ]),
        {
          ...limits,
          maxTotalBytes: 600,
        },
      ),
    ).toThrow(/too large when unpacked/);

    // Lie about the uncompressed size in the central directory: inflating must stop at that size.
    const zip = createTestZip([{ name: 'bomb', data: 'z'.repeat(5000) }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const centralAt = view.getUint32(zip.byteLength - 22 + 16, true);
    view.setUint32(centralAt + 24, 10, true);
    expect(() => readZip(zip)).toThrow(/could not be unpacked|wrong size/);
  });

  it('detects a damaged archive', () => {
    const zip = createTestZip([{ name: 'a', data: 'hello' }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    view.setUint32(zip.byteLength - 22 + 16, 5, true); // central directory offset points at junk
    expect(() => readZip(zip)).toThrow(/damaged/);
  });
});

describe('safeZipPath', () => {
  it('cleans harmless paths', () => {
    expect(safeZipPath('./a//b/./c.js')).toBe('a/b/c.js');
  });
});
