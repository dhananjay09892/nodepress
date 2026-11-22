import { describe, expect, it } from 'vitest';
import {
  exportMediaZip,
  importMediaZip,
  MediaBackupError,
  MEDIA_MANIFEST,
  remapBlockMedia,
} from './backup-media.js';
import { HookRegistry } from './hooks.js';
import { MediaService, type ImageProcessor } from './media.js';
import { memoryMediaStore, memoryStorage } from './testing/memory-storage.js';
import { readZip, writeZip } from './zip.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);
const PDF = Buffer.from('%PDF-1.7 fake');
const PHP = Buffer.from('<?php system($_GET["c"]); ?>');

const processor: ImageProcessor = {
  async inspect() {
    return { width: 100, height: 50 };
  },
  async resize(_data, options) {
    return Buffer.from(`resized-${options.width}-${options.format}`);
  },
};

function site() {
  const store = memoryMediaStore();
  const storage = memoryStorage();
  const media = new MediaService({ store, storage, processor, hooks: new HookRegistry() });
  return { store, storage, media };
}

describe('writeZip', () => {
  it('round-trips through the strict reader', () => {
    const zip = writeZip([
      { path: 'a/b.txt', data: new TextEncoder().encode('hello') },
      { path: 'empty', data: new Uint8Array() },
    ]);
    const files = readZip(zip);
    expect(files.map((f) => f.path)).toEqual(['a/b.txt', 'empty']);
    expect(new TextDecoder().decode(files[0]!.data)).toBe('hello');
  });

  it('refuses unsafe and duplicate names', () => {
    expect(() => writeZip([{ path: '../x', data: new Uint8Array() }])).toThrow(/unsafe/);
    expect(() =>
      writeZip([
        { path: 'x', data: new Uint8Array() },
        { path: './x', data: new Uint8Array() },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe('media zip round trip', () => {
  it('restores files, alt text and variants into an empty site and maps the ids', async () => {
    const from = site();
    const a = await from.media.upload({ data: PNG, filename: 'cat.png', alt: 'A cat' });
    const b = await from.media.upload({ data: PDF, filename: 'doc.pdf', alt: '' });

    const { zip, manifest } = await exportMediaZip({ media: from.media, storage: from.storage });
    expect(manifest.media.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(readZip(zip).some((f) => f.path === MEDIA_MANIFEST)).toBe(true);

    const to = site();
    // Make the new ids differ from the old ones.
    await to.media.upload({ data: PDF, filename: 'other.pdf' });
    const summary = await importMediaZip(zip, { media: to.media });
    expect(summary.imported).toBe(2);
    expect(summary.failed).toEqual([]);
    const newA = await to.media.get(summary.idMap[String(a.id)]!);
    expect(newA?.alt).toBe('A cat');
    expect(newA?.mime).toBe('image/png');
    expect(Object.keys(newA?.variants ?? {}).length).toBeGreaterThan(0);
    expect((await to.media.get(summary.idMap[String(b.id)]!))?.mime).toBe('application/pdf');
    expect(summary.idMap[String(a.id)]).not.toBe(a.id);
  });

  it('names files missing from storage and keeps the rest', async () => {
    const from = site();
    const a = await from.media.upload({ data: PDF, filename: 'a.pdf' });
    const b = await from.media.upload({ data: PDF, filename: 'b.pdf' });
    from.storage.files.delete(a.path);
    const { manifest } = await exportMediaZip({ media: from.media, storage: from.storage });
    expect(manifest.media.map((m) => m.id)).toEqual([b.id]);
    expect(manifest.omitted).toEqual([{ id: a.id, reason: 'file missing from storage' }]);
  });

  it('stops at the size cap and reports the rest', async () => {
    const from = site();
    await from.media.upload({ data: PDF, filename: 'a.pdf' });
    await from.media.upload({ data: PDF, filename: 'b.pdf' });
    const { manifest } = await exportMediaZip({
      media: from.media,
      storage: from.storage,
      maxBytes: PDF.byteLength,
    });
    expect(manifest.media).toHaveLength(1);
    expect(manifest.omitted[0]?.reason).toMatch(/limit/);
  });

  it('reports a file the media service refuses and goes on', async () => {
    const manifest = {
      format: 'nodepress-media',
      version: 1,
      exportedAt: '2026-01-01T00:00:00Z',
      media: [
        { id: 1, file: 'media/1.php', mime: 'image/png', alt: '', size: PHP.byteLength },
        { id: 2, file: 'media/2.pdf', mime: 'application/pdf', alt: 'ok', size: PDF.byteLength },
        { id: 3, file: 'media/3.pdf', mime: 'application/pdf', alt: '', size: 1 },
      ],
      omitted: [],
    };
    const zip = writeZip([
      { path: MEDIA_MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest)) },
      { path: 'media/1.php', data: PHP },
      { path: 'media/2.pdf', data: PDF },
    ]);
    const to = site();
    const summary = await importMediaZip(zip, { media: to.media });
    expect(summary.imported).toBe(1);
    expect(summary.failed.map((f) => f.id)).toEqual([1, 3]);
    expect(summary.failed[0]?.reason).toMatch(/not allowed/);
    expect(summary.failed[1]?.reason).toMatch(/missing/);
    expect(to.store.rows.size).toBe(1);
  });

  it('rejects a bad zip, a missing manifest and a malformed manifest without changes', async () => {
    const to = site();
    const deps = { media: to.media };
    await expect(importMediaZip(new Uint8Array([1, 2, 3]), deps)).rejects.toBeInstanceOf(
      MediaBackupError,
    );
    await expect(
      importMediaZip(writeZip([{ path: 'x.txt', data: new Uint8Array() }]), deps),
    ).rejects.toThrow(/not a NodePress media backup/);
    await expect(
      importMediaZip(
        writeZip([{ path: MEDIA_MANIFEST, data: new TextEncoder().encode('{') }]),
        deps,
      ),
    ).rejects.toThrow(/valid JSON/);
    await expect(
      importMediaZip(
        writeZip([{ path: MEDIA_MANIFEST, data: new TextEncoder().encode('{"format":"x"}') }]),
        deps,
      ),
    ).rejects.toThrow(/not a NodePress media backup/);
    expect(to.store.rows.size).toBe(0);
  });
});

describe('remapBlockMedia', () => {
  it('rewrites mediaId in nested blocks and counts the ones it cannot map', () => {
    const blocks = [
      { type: 'core/image', attrs: { mediaId: '5', alt: 'x' } },
      {
        type: 'core/list',
        attrs: {},
        children: [{ type: 'core/image', attrs: { mediaId: '9', alt: '' } }],
      },
      { type: 'core/paragraph', text: 'hi' },
    ];
    const result = remapBlockMedia(blocks, { '5': 50 });
    expect(result.unmapped).toBe(1);
    expect(result.blocks).toEqual([
      { type: 'core/image', attrs: { mediaId: '50', alt: 'x' } },
      {
        type: 'core/list',
        attrs: {},
        children: [{ type: 'core/image', attrs: { mediaId: '9', alt: '' } }],
      },
      { type: 'core/paragraph', text: 'hi' },
    ]);
    // The input is not changed.
    expect((blocks[0]!.attrs as { mediaId: string }).mediaId).toBe('5');
  });
});
