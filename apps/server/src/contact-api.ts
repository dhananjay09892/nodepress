import type { Capabilities, ContactFormService } from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';

export interface ContactRoutesOptions {
  contact: ContactFormService;
  capabilities: Capabilities;
  /** Trust `X-Forwarded-For` (set when running behind a reverse proxy). */
  trustProxy?: boolean;
}

const MAX_BODY_BYTES = 16 * 1024;
const PAGE_SIZE = 50;

function senderOf(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (forwarded) return forwarded;
  }
  const env = c.env as unknown as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

/**
 * Routes for `/api/v1/contact`:
 * - `GET /token` (public): a signed token to send back with the message; a form must be shown at
 *   least a few seconds before it is submitted.
 * - `POST /` (public, JSON `{ name, email, message, token, website }`): `website` is a hidden
 *   honeypot field and must stay empty. Answers 201 `{ ok: true }`, 400 with field errors,
 *   400 `bad_token` or 429 with `Retry-After`.
 * - `GET /submissions?page=` (`manage_options`): the stored messages, newest first.
 */
export function createContactRoutes(auth: Auth, options: ContactRoutesOptions): Hono<AuthEnv> {
  const { contact, capabilities } = options;
  const routes = new Hono<AuthEnv>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  routes.get('/token', (c) => c.json({ token: contact.issueToken() }));

  routes.post('/', async (c) => {
    const type = c.req.header('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const result = await contact.submit(body as Record<string, unknown>, senderOf(c, options.trustProxy ?? false));
    if (result.ok) return c.json({ ok: true }, 201);
    if (result.error === 'rate_limited') {
      c.header('Retry-After', String(Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 1000))));
      return c.json({ error: 'rate_limited' }, 429);
    }
    return c.json({ error: result.error === 'bad_token' ? 'bad_token' : 'invalid_request', fields: result.fields }, 400);
  });

  routes.get('/submissions', auth.authenticate, async (c) => {
    if (!(await capabilities.can(c.get('principal')!.user, 'manage_options'))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const page = Math.max(1, Math.floor(Number(c.req.query('page') ?? '1')) || 1);
    const { items, total } = await contact.list({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
    return c.json({
      total,
      page,
      pageSize: PAGE_SIZE,
      submissions: items.map((s) => ({
        id: s.id,
        form: s.form,
        name: s.name,
        email: s.email,
        message: s.message,
        mailStatus: s.mailStatus,
        createdAt: s.createdAt.toISOString(),
      })),
    });
  });

  return routes;
}
