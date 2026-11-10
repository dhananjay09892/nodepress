import {
  WebhookNotFoundError,
  WebhookValidationError,
  type Capabilities,
  type Webhook,
  type WebhookService,
} from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';

export interface WebhookRoutesOptions {
  webhooks: WebhookService;
  capabilities: Capabilities;
}

const MAX_BODY_BYTES = 16 * 1024;

export function publicWebhook(hook: Webhook) {
  return {
    id: hook.id,
    url: hook.url,
    events: hook.events,
    description: hook.description,
    active: hook.active,
    createdAt: hook.createdAt.toISOString(),
  };
}

/**
 * Routes for `/api/v1/webhooks`. Needs the `manage_options` capability; accepts a session (with
 * CSRF token) or a Bearer API token. The signing secret is returned only when a webhook is
 * created or its secret rotated.
 */
export function createWebhookRoutes(auth: Auth, options: WebhookRoutesOptions): Hono<AuthEnv> {
  const { webhooks, capabilities } = options;
  const routes = new Hono<AuthEnv>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use('*', auth.originGuard);
  routes.use('*', auth.authenticate);
  routes.use('*', async (c, next) => {
    if (!(await capabilities.can(c.get('principal')!.user, 'manage_options'))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });

  const readJson = async (c: Context<AuthEnv>) => {
    const type = c.req.header('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/json')) {
      return { error: c.json({ error: 'unsupported_media_type' }, 415) } as const;
    }
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return { error: c.json({ error: 'payload_too_large' }, 413) } as const;
    }
    try {
      const body: unknown = JSON.parse(raw);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { error: c.json({ error: 'invalid_request' }, 400) } as const;
      }
      return { body: body as Record<string, unknown> } as const;
    } catch {
      return { error: c.json({ error: 'invalid_json' }, 400) } as const;
    }
  };

  const fail = (c: Context<AuthEnv>, error: unknown) => {
    if (error instanceof WebhookValidationError) {
      return c.json({ error: 'invalid_request', message: error.message }, 400);
    }
    if (error instanceof WebhookNotFoundError) return c.json({ error: 'not_found' }, 404);
    throw error;
  };

  routes.get('/', async (c) => c.json({ webhooks: (await webhooks.list()).map(publicWebhook) }));

  routes.post('/', async (c) => {
    const parsed = await readJson(c);
    if ('error' in parsed) return parsed.error;
    const { url, events, description, active } = parsed.body;
    try {
      const created = await webhooks.create({
        url: url as string,
        ...(events !== undefined ? { events: events as string[] } : {}),
        ...(description !== undefined ? { description: description as string } : {}),
        ...(active !== undefined ? { active: active as boolean } : {}),
      });
      return c.json({ webhook: publicWebhook(created), secret: created.secret }, 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.get('/:id', async (c) => {
    const hook = await webhooks.get(c.req.param('id'));
    return hook ? c.json({ webhook: publicWebhook(hook) }) : c.json({ error: 'not_found' }, 404);
  });

  routes.patch('/:id', async (c) => {
    const parsed = await readJson(c);
    if ('error' in parsed) return parsed.error;
    const { url, events, description, active } = parsed.body;
    try {
      const updated = await webhooks.update(c.req.param('id'), {
        ...(url !== undefined ? { url: url as string } : {}),
        ...(events !== undefined ? { events: events as string[] } : {}),
        ...(description !== undefined ? { description: description as string } : {}),
        ...(active !== undefined ? { active: active as boolean } : {}),
      });
      return c.json({ webhook: publicWebhook(updated) });
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.delete('/:id', async (c) =>
    (await webhooks.delete(c.req.param('id')))
      ? c.body(null, 204)
      : c.json({ error: 'not_found' }, 404),
  );

  routes.post('/:id/rotate-secret', async (c) => {
    try {
      const rotated = await webhooks.rotateSecret(c.req.param('id'));
      return c.json({ webhook: publicWebhook(rotated), secret: rotated.secret });
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.post('/:id/test', async (c) => {
    try {
      const deliveryId = await webhooks.sendTest(c.req.param('id'));
      return c.json({ deliveryId }, 202);
    } catch (error) {
      return fail(c, error);
    }
  });

  return routes;
}
