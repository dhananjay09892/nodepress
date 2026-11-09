import { beforeEach, describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import {
  MediaNotFoundError,
  MediaService,
  MediaValidationError,
  detectType,
  safeBaseName,
  type ImageProcessor,
  type ResizeOptions,
} from './media.js';
import { memoryMediaStore, memoryStorage } from './testing/memory-storage.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg')]);
const GIF = Buffer.from('GIF89a-fake');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7 fake');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const PHP = Buffer.from('<?php system($_GET["c"]); ?>');

/** Fake processor: reports a configurable size and records every resize call. */
function fakeProcessor(size = { width: 2000, height: 1000 }) {
  const calls: ResizeOptions[] = [];
  const processor: ImageProcessor & { calls: ResizeOptions[]; size: typeof size } = {
    calls,
    size,
    async inspect() {
      return processor.size;
    },
    async resize(_data, options) {
      calls.push(options);
      return Buffer.from(`resized-${options.fit}-${options.width}-${options.format}`);
    },
  };
  return processor;
}

let store: ReturnType<typeof memoryMediaStore>;
let storage: ReturnType<typeof memoryStorage>;
let processor: ReturnType<typeof fakeProcessor>;
let hooks: HookRegistry;
let media: MediaService;

beforeEach(() => {
  store = memoryMediaStore();
  storage = memoryStorage();
  processor = fakeProcessor();
  hooks = new HookRegistry();
  media = new MediaService({
    store,
    storage,
    processor,
    hooks,
    now: () => new Date('2026-11-09T12:00:00Z'),
    maxBytes: 1024,
  });
});

describe('detectType', () => {
  it('recognises allowed types by their first bytes', () => {
    expect(detectType(PNG)?.mime).toBe('image/png');
    expect(detectType(JPEG)?.mime).toBe('image/jpeg');
    expect(detectType(GIF)?.mime).toBe('image/gif');
    expect(detectType(WEBP)?.mime).toBe('image/webp');
    expect(detectType(PDF)?.mime).toBe('application/pdf');
  });

  it('does not recognise SVG, scripts or empty input', () => {
    expect(detectType(SVG)).toBeUndefined();
    expect(detectType(PHP)).toBeUndefined();
    expect(detectType(new Uint8Array())).toBeUndefined();
  });
});

describe('safeBaseName', () => {
  it('produces lowercase ascii and drops directories and the extension', () => {
    expect(safeBaseName('My Cat Photo.JPG')).toBe('my-cat-photo');
    expect(safeBaseName('../../etc/passwd')).toBe('passwd');
    expect(safeBaseName('C:\\evil\\Crème brûlée.png')).toBe('creme-brulee');
    expect(safeBaseName('.htaccess')).toBe('htaccess');
    expect(safeBaseName('日本語.png')).toBe('file');
    expect(safeBaseName('a'.repeat(200) + '.png').length).toBeLessThanOrEqual(60);
  });
});

describe('MediaService.upload', () => {
  it('stores an image with its variants and records it', async () => {
    const seen: number[] = [];
    hooks.addAction('media:uploaded', (m) => void seen.push(m.id));
    const result = await media.upload({
      data: JPEG,
      filename: 'My Photo.JPG',
      declaredMime: 'image/jpeg',
      alt: '  A photo  ',
      uploadedBy: 7,
    });

    expect(result).toMatchObject({
      mime: 'image/jpeg',
      size: JPEG.length,
      width: 2000,
      height: 1000,
      alt: 'A photo',
      uploadedBy: 7,
    });
    expect(result.path).toMatch(/^uploads\/2026\/11\/my-photo-[0-9a-f]{8}\.jpg$/);
    expect(Object.keys(result.variants).sort()).toEqual(['large', 'medium', 'thumbnail', 'webp']);
    expect(result.variants.thumbnail).toMatch(/-thumbnail\.jpg$/);
    expect(result.variants.webp).toMatch(/\.webp$/);
    expect(storage.files.get(result.path)?.data.equals(JPEG)).toBe(true);
    for (const key of Object.values(result.variants)) expect(storage.files.has(key)).toBe(true);
    expect(storage.files.size).toBe(5);
    expect(seen).toEqual([result.id]);
  });

  it('uses the expected resize settings', async () => {
    await media.upload({ data: PNG, filename: 'a.png' });
    expect(processor.calls).toEqual([
      { width: 150, height: 150, fit: 'cover', format: 'png' },
      { width: 300, fit: 'inside', format: 'png' },
      { width: 1024, fit: 'inside', format: 'png' },
      { width: 2000, fit: 'inside', format: 'webp' },
    ]);
  });

  it('skips medium and large for small images and webp for webp sources', async () => {
    processor.size = { width: 200, height: 200 };
    const small = await media.upload({ data: WEBP, filename: 'small.webp' });
    expect(Object.keys(small.variants)).toEqual(['thumbnail']);
    expect(small.variants.thumbnail).toMatch(/-thumbnail\.webp$/);
  });

  it('converts gif variants to webp', async () => {
    const gif = await media.upload({ data: GIF, filename: 'anim.gif' });
    expect(gif.variants.thumbnail).toMatch(/\.webp$/);
    expect(gif.variants.webp).toBeUndefined();
  });

  it('stores a PDF without variants or dimensions', async () => {
    const pdf = await media.upload({ data: PDF, filename: 'Report.pdf' });
    expect(pdf).toMatchObject({ mime: 'application/pdf', width: null, height: null, variants: {} });
    expect(pdf.path).toMatch(/\.pdf$/);
    expect(processor.calls).toHaveLength(0);
  });

  it('derives the extension from the content, not the filename', async () => {
    const result = await media.upload({ data: PNG, filename: 'shell.php' });
    expect(result.path).toMatch(/shell-[0-9a-f]{8}\.png$/);
  });

  it.each([
    ['SVG', SVG, 'evil.svg'],
    ['PHP script', PHP, 'shell.php.png'],
    ['plain text', Buffer.from('hello'), 'a.txt'],
  ])('blocks %s', async (_name, data, filename) => {
    await expect(media.upload({ data, filename })).rejects.toMatchObject({
      code: 'unsupported_type',
    });
    expect(storage.files.size).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it('rejects a declared type that disagrees with the content', async () => {
    await expect(
      media.upload({ data: PHP, filename: 'a.png', declaredMime: 'image/png' }),
    ).rejects.toMatchObject({ code: 'unsupported_type' });
    await expect(
      media.upload({ data: PNG, filename: 'a.jpg', declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'type_mismatch' });
    await expect(
      media.upload({ data: PNG, filename: 'a.png', declaredMime: 'application/octet-stream' }),
    ).resolves.toBeDefined();
  });

  it('enforces the size limit and rejects empty files', async () => {
    await expect(
      media.upload({ data: Buffer.concat([PNG, Buffer.alloc(1100)]), filename: 'big.png' }),
    ).rejects.toMatchObject({ code: 'too_large' });
    await expect(media.upload({ data: new Uint8Array(), filename: 'x.png' })).rejects.toMatchObject(
      { code: 'empty' },
    );
  });

  it('rejects unreadable images and oversized dimensions', async () => {
    processor.inspect = async () => {
      throw new Error('corrupt');
    };
    await expect(media.upload({ data: PNG, filename: 'bad.png' })).rejects.toMatchObject({
      code: 'invalid_image',
    });
    processor.inspect = async () => ({ width: 10_000, height: 10_000 });
    await expect(media.upload({ data: PNG, filename: 'bomb.png' })).rejects.toMatchObject({
      code: 'invalid_image',
    });
    expect(storage.files.size).toBe(0);
  });

  it('rejects over-long alt text', async () => {
    await expect(
      media.upload({ data: PNG, filename: 'a.png', alt: 'x'.repeat(501) }),
    ).rejects.toBeInstanceOf(MediaValidationError);
  });

  it('removes written files when a variant fails', async () => {
    let n = 0;
    processor.resize = async () => {
      if (++n === 2) throw new Error('boom');
      return Buffer.from('ok');
    };
    await expect(media.upload({ data: PNG, filename: 'a.png' })).rejects.toThrow('boom');
    expect(storage.files.size).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it('removes written files when the record cannot be saved', async () => {
    store.insert = async () => {
      throw new Error('db down');
    };
    await expect(media.upload({ data: PNG, filename: 'a.png' })).rejects.toThrow('db down');
    expect(storage.files.size).toBe(0);
  });

  it('lets a plugin restrict the allowed types', async () => {
    hooks.addFilter('media:allowed-types', (types) => types.filter((t) => t !== 'application/pdf'));
    await expect(media.upload({ data: PDF, filename: 'a.pdf' })).rejects.toMatchObject({
      code: 'unsupported_type',
    });
    await expect(media.upload({ data: PNG, filename: 'a.png' })).resolves.toBeDefined();
  });

  it('ignores types a plugin adds that core cannot recognise', async () => {
    hooks.addFilter('media:allowed-types', (types) => [...types, 'image/svg+xml']);
    await expect(media.upload({ data: SVG, filename: 'a.svg' })).rejects.toMatchObject({
      code: 'unsupported_type',
    });
  });
});

describe('MediaService other operations', () => {
  it('lists newest first, filtered by uploader, with clamped paging', async () => {
    const a = await media.upload({ data: PDF, filename: 'a.pdf', uploadedBy: 1 });
    const b = await media.upload({ data: PDF, filename: 'b.pdf', uploadedBy: 2 });
    expect((await media.list()).map((m) => m.id)).toEqual([b.id, a.id]);
    expect((await media.list({ uploadedBy: 1 })).map((m) => m.id)).toEqual([a.id]);
    expect((await media.list({ limit: 1, offset: 1 })).map((m) => m.id)).toEqual([a.id]);
    expect(await media.list({ limit: -5, offset: -5 })).toHaveLength(1);
  });

  it('updates alt text', async () => {
    const m = await media.upload({ data: PNG, filename: 'a.png' });
    expect((await media.updateAlt(m.id, ' New ')).alt).toBe('New');
    await expect(media.updateAlt(999, 'x')).rejects.toBeInstanceOf(MediaNotFoundError);
    await expect(media.updateAlt(m.id, 'x'.repeat(501))).rejects.toBeInstanceOf(
      MediaValidationError,
    );
  });

  it('deletes the record and all files', async () => {
    const deleted: number[] = [];
    hooks.addAction('media:deleted', (m) => void deleted.push(m.id));
    const m = await media.upload({ data: PNG, filename: 'a.png' });
    expect(await media.delete(m.id)).toBe(true);
    expect(storage.files.size).toBe(0);
    expect(await media.get(m.id)).toBeUndefined();
    expect(deleted).toEqual([m.id]);
    expect(await media.delete(m.id)).toBe(false);
  });

  it('still succeeds when a file cannot be removed', async () => {
    const m = await media.upload({ data: PDF, filename: 'a.pdf' });
    storage.delete = async () => {
      throw new Error('disk error');
    };
    expect(await media.delete(m.id)).toBe(true);
  });
});
