import {
  MediaNotFoundError,
  MediaValidationError,
  type Capabilities,
  type Media,
  type MediaService,
  type StorageAdapter,
} from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';

export interface MediaRoutesOptions {
  media: MediaService;
  storage: StorageAdapter;
  capabilities: Capabilities;
}

/** Multipart framing (boundaries, field headers) allowed on top of the file size limit. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_ALT_BODY_BYTES = 8 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

const ERROR_STATUS = {
  empty: 400,
  too_large: 413,
  unsupported_type: 415,
  type_mismatch: 415,
  invalid_image: 422,
  invalid_alt: 400,
} as const;

/** The JSON shape of a media item: storage keys become URLs under `/uploads`. */
export function publicMedia(media: Media) {
  return {
    id: media.id,
    url: `/${media.path}`,
    mime: media.mime,
    size: media.size,
    width: media.width,
    height: media.height,
    alt: media.alt,
    variants: Object.fromEntries(
      Object.entries(media.variants).map(([name, key]) => [name, `/${key}`]),
    ),
    uploadedBy: media.uploadedBy,
    createdAt: media.createdAt.toISOString(),
  };
}

/**
 * Read a request body but give up as soon as it exceeds `limit` bytes, so an oversized upload
 * is never held in memory. Returns `null` when the limit is exceeded.
 */
async function readLimited(request: Request, limit: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Routes for `/api/v1/media`. Accepts a session (with CSRF token) or a Bearer API token. */
export function createMediaRoutes(auth: Auth, options: MediaRoutesOptions): Hono<AuthEnv> {
  const { media, capabilities } = options;
  const routes = new Hono<AuthEnv>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use('*', auth.originGuard);
  routes.use('*', auth.authenticate);
  routes.use('*', async (c, next) => {
    if (!(await capabilities.can(c.get('principal')!.user, 'upload_files'))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });

  /** Authors manage their own files; touching someone else's needs `edit_others_posts`. */
  const mayManage = async (c: Context<AuthEnv>, item: Media): Promise<boolean> => {
    const user = c.get('principal')!.user;
    return item.uploadedBy === user.id || (await capabilities.can(user, 'edit_others_posts'));
  };

  const parseId = (c: Context<AuthEnv>): number | null => {
    const id = Number(c.req.param('id'));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };

  routes.post('/', async (c) => {
    const type = c.req.header('content-type') ?? '';
    if (!type.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    const body = await readLimited(c.req.raw, media.maxBytes + MULTIPART_OVERHEAD_BYTES);
    if (!body) return c.json({ error: 'payload_too_large' }, 413);

    let form: FormData;
    try {
      form = await new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': type },
        body,
      }).formData();
    } catch {
      return c.json({ error: 'invalid_request', message: 'malformed multipart body' }, 400);
    }
    const file = form.get('file');
    const alt = form.get('alt');
    if (!(file instanceof File) || (alt !== null && typeof alt !== 'string')) {
      return c.json({ error: 'invalid_request', message: 'send the upload as a "file" field' }, 400);
    }
    try {
      const created = await media.upload({
        data: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
        declaredMime: file.type || undefined,
        alt: alt ?? '',
        uploadedBy: c.get('principal')!.user.id,
      });
      return c.json({ media: publicMedia(created) }, 201);
    } catch (error) {
      if (error instanceof MediaValidationError) {
        return c.json(
          { error: error.code, message: error.message },
          ERROR_STATUS[error.code],
        );
      }
      throw error;
    }
  });

  routes.get('/', async (c) => {
    const user = c.get('principal')!.user;
    const limit = Number(c.req.query('limit') ?? Number.NaN);
    const offset = Number(c.req.query('offset') ?? Number.NaN);
    const all = await capabilities.can(user, 'edit_others_posts');
    const items = await media.list({
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(offset) ? { offset } : {}),
      ...(all ? {} : { uploadedBy: user.id }),
    });
    return c.json({ media: items.map(publicMedia) });
  });

  routes.get('/:id', async (c) => {
    const id = parseId(c);
    const item = id === null ? undefined : await media.get(id);
    if (!item || !(await mayManage(c, item))) return c.json({ error: 'not_found' }, 404);
    return c.json({ media: publicMedia(item) });
  });

  routes.patch('/:id', async (c) => {
    const id = parseId(c);
    const item = id === null ? undefined : await media.get(id);
    if (!item || !(await mayManage(c, item))) return c.json({ error: 'not_found' }, 404);
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    const raw = await c.req.text();
    if (raw.length > MAX_ALT_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const { alt } = (body ?? {}) as { alt?: unknown };
    if (typeof alt !== 'string') return c.json({ error: 'invalid_request' }, 400);
    try {
      return c.json({ media: publicMedia(await media.updateAlt(item.id, alt)) });
    } catch (error) {
      if (error instanceof MediaValidationError) {
        return c.json({ error: error.code, message: error.message }, 400);
      }
      if (error instanceof MediaNotFoundError) return c.json({ error: 'not_found' }, 404);
      throw error;
    }
  });

  routes.delete('/:id', async (c) => {
    const id = parseId(c);
    const item = id === null ? undefined : await media.get(id);
    if (!item || !(await mayManage(c, item))) return c.json({ error: 'not_found' }, 404);
    await media.delete(item.id);
    return c.body(null, 204);
  });

  return routes;
}

/**
 * Public file serving for `/uploads/*`. Only keys under `uploads/` are served, the type comes
 * from the extension NodePress itself chose at upload time, and browsers are told not to sniff
 * or run anything, so even a surprising file cannot execute in the site's origin.
 */
export function createUploadsHandler(storage: StorageAdapter) {
  return async (c: Context): Promise<Response> => {
    let key: string;
    try {
      key = decodeURIComponent(c.req.path.slice(1));
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
    const ext = key.split('.').pop()?.toLowerCase() ?? '';
    const contentType = CONTENT_TYPES[ext];
    if (!key.startsWith('uploads/') || !contentType) return c.json({ error: 'not_found' }, 404);
    let data: Buffer | undefined;
    try {
      data = await storage.get(key);
    } catch {
      return c.json({ error: 'not_found' }, 404); // an invalid key
    }
    if (!data) return c.json({ error: 'not_found' }, 404);
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        // Names contain random bytes and are never reused, so files never change.
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...(ext === 'pdf' ? { 'Content-Disposition': 'attachment' } : {}),
      },
    });
  };
}
