import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import { MediaService } from './media.js';
import { createSharpProcessor } from './sharp-processor.js';
import { memoryMediaStore, memoryStorage } from './testing/memory-storage.js';

async function image(width: number, height: number, format: 'png' | 'jpeg' = 'png') {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  });
  return format === 'png' ? base.png().toBuffer() : base.jpeg().toBuffer();
}

describe('sharp image processor', () => {
  const processor = createSharpProcessor();

  it('reads dimensions and rejects non-images', async () => {
    expect(await processor.inspect(await image(40, 20))).toEqual({ width: 40, height: 20 });
    await expect(processor.inspect(Buffer.from('not an image'))).rejects.toThrow();
  });

  it('resizes, converts and never enlarges', async () => {
    const source = await image(400, 200);
    const cover = await sharp(
      await processor.resize(source, { width: 100, height: 100, fit: 'cover', format: 'jpeg' }),
    ).metadata();
    expect(cover).toMatchObject({ format: 'jpeg', width: 100, height: 100 });

    const inside = await sharp(
      await processor.resize(source, { width: 200, fit: 'inside', format: 'webp' }),
    ).metadata();
    expect(inside).toMatchObject({ format: 'webp', width: 200, height: 100 });

    const same = await sharp(
      await processor.resize(source, { width: 1000, fit: 'inside', format: 'png' }),
    ).metadata();
    expect(same).toMatchObject({ format: 'png', width: 400, height: 200 });
  });

  it('applies EXIF orientation to inspected size', async () => {
    const rotated = await sharp(await image(40, 20, 'jpeg'))
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(await processor.inspect(rotated)).toEqual({ width: 20, height: 40 });
  });

  it('generates real variants end to end', async () => {
    const storage = memoryStorage();
    const media = new MediaService({
      store: memoryMediaStore(),
      storage,
      processor,
      hooks: new HookRegistry(),
    });
    const result = await media.upload({
      data: await image(2000, 1000, 'jpeg'),
      filename: 'wide.jpg',
      declaredMime: 'image/jpeg',
    });
    expect(result).toMatchObject({ width: 2000, height: 1000 });
    const dims = async (key: string) => {
      const meta = await sharp(storage.files.get(key)!.data).metadata();
      return [meta.format, meta.width, meta.height];
    };
    expect(await dims(result.variants.thumbnail!)).toEqual(['jpeg', 150, 150]);
    expect(await dims(result.variants.medium!)).toEqual(['jpeg', 300, 150]);
    expect(await dims(result.variants.large!)).toEqual(['jpeg', 1024, 512]);
    expect(await dims(result.variants.webp!)).toEqual(['webp', 2000, 1000]);
  });

  it('rejects a corrupt file that only looks like a PNG', async () => {
    const media = new MediaService({
      store: memoryMediaStore(),
      storage: memoryStorage(),
      processor,
      hooks: new HookRegistry(),
    });
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('garbage'),
    ]);
    await expect(media.upload({ data: fake, filename: 'x.png' })).rejects.toMatchObject({
      code: 'invalid_image',
    });
  });
});
