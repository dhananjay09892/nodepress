import type { ImageProcessor } from './media.js';

/** Largest image (in pixels) sharp will decode; matches the service default. */
const LIMIT_INPUT_PIXELS = 50_000_000;

/**
 * Production image processor backed by `sharp`. The module is loaded on first use, so sites
 * (and tests) that never touch images do not pay for the native binary.
 */
export function createSharpProcessor(): ImageProcessor {
  const load = async () => (await import('sharp')).default;
  const open = async (data: Buffer) =>
    (await load())(data, { failOn: 'error', limitInputPixels: LIMIT_INPUT_PIXELS });
  return {
    async inspect(data) {
      const meta = await (await open(data)).metadata();
      if (!meta.width || !meta.height) throw new Error('image has no dimensions');
      // EXIF orientations 5-8 are rotated 90 degrees when displayed.
      const turned = (meta.orientation ?? 1) >= 5;
      return turned
        ? { width: meta.height, height: meta.width }
        : { width: meta.width, height: meta.height };
    },
    async resize(data, options) {
      // rotate() applies the EXIF orientation; sharp drops all other metadata on output.
      let image = (await open(data)).rotate().resize({
        width: options.width,
        ...(options.height !== undefined ? { height: options.height } : {}),
        fit: options.fit,
        withoutEnlargement: true,
      });
      if (options.format === 'jpeg') image = image.jpeg({ quality: 82, mozjpeg: true });
      else if (options.format === 'png') image = image.png({ compressionLevel: 9 });
      else image = image.webp({ quality: 80 });
      return image.toBuffer();
    },
  };
}
