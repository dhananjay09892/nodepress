import {
  PluginRouteBodyError,
  type Capabilities,
  type Logger,
  type PluginRouteMethod,
  type PluginRouteRegistry,
  type PluginRouteResponse,
} from '@nodepress/core';
import { Hono, type Context } from 'hono';
import type { Auth, AuthEnv } from './auth.js';

export interface PluginRoutesApiOptions {
  registry: Pick<PluginRouteRegistry, 'match'>;
  capabilities: Capabilities;
  logger?: Logger;
  /** Longest a handler may run before the request answers 504. Default 30 s. */
  timeoutMs?: number;
}

/** Largest request body a plugin route reads. */
export const MAX_PLUGIN_BODY_BYTES = 1024 * 1024;

/** Response headers a plugin may not set: cookies and anything that changes the site's security policy. */
const FORBIDDEN_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'content-length',
  'transfer-encoding',
  'connection',
]);

/**
 * Serves the routes plugins added with `context.routes.add()` under
 * `/api/v1/plugins/<plugin name>/…`. Mount it before the plugin management routes: a request
 * that matches no plugin route falls through to them (and then to a 404).
 *
 * For a route with a capability the caller must be signed in (session with CSRF token for
 * writes, or a Bearer API token) and hold it: the answer is `401` or `403` and the handler never
 * runs. A `public` route needs nothing. A handler that throws answers `500 { error:
 * "plugin_error" }` without details and is logged; it cannot affect other routes.
 */
export function createPluginRouteDispatcher(
  auth: Auth,
  options: PluginRoutesApiOptions,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const timeoutMs = options.timeoutMs ?? 30_000;

  /** Run a middleware by hand; returns the response it sent when it refused, or `null`. */
  async function pass(c: Context<AuthEnv>, middleware: typeof auth.authenticate) {
    let proceeded = false;
    const result = await middleware(c, async () => {
      proceeded = true;
    });
    return proceeded ? null : ((result as Response | undefined) ?? c.res);
  }

  app.all('/:name/*', async (c, next) => {
    const name = c.req.param('name');
    const prefix = `/api/v1/plugins/${name}`;
    const path = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) || '/' : '/';
    const match = options.registry.match(name, c.req.method, path);
    if (!match) return next();

    const { capability, handler } = match.definition;
    let user: { id: number; email: string; role: string } | null = null;
    if (capability !== 'public') {
      const refused = (await pass(c, auth.originGuard)) ?? (await pass(c, auth.authenticate));
      if (refused) return refused;
      const principal = c.get('principal')!.user;
      if (!(await options.capabilities.can(principal, capability))) {
        return c.json({ error: 'forbidden' }, 403);
      }
      user = { id: principal.id, email: principal.email, role: principal.role };
    }

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const query: Record<string, string> = {};
    for (const [key, value] of new URL(c.req.url).searchParams) query[key] ??= value;

    let parsed: Promise<unknown> | undefined;
    const request = {
      method: c.req.method as PluginRouteMethod,
      path,
      params: match.params,
      query,
      headers,
      user,
      json: () => {
        parsed ??= (async () => {
          const text = await c.req.text();
          if (text.length > MAX_PLUGIN_BODY_BYTES) {
            throw new PluginRouteBodyError('The request body is too large.');
          }
          try {
            return JSON.parse(text);
          } catch {
            throw new PluginRouteBodyError('The request body is not valid JSON.');
          }
        })();
        return parsed;
      },
    };

    let result: PluginRouteResponse;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => handler(request)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof PluginRouteBodyError) {
        return c.json({ error: 'invalid_request', message: error.message }, 400);
      }
      if (error instanceof Error && error.message === 'timeout') {
        options.logger?.error(`Plugin "${name}" route ${c.req.method} ${path} timed out`);
        return c.json({ error: 'plugin_timeout' }, 504);
      }
      options.logger?.error(`Plugin "${name}" route ${c.req.method} ${path} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: 'plugin_error' }, 500);
    } finally {
      if (timer) clearTimeout(timer);
    }

    return respond(c, result ?? {});
  });

  return app;
}

function respond(c: Context<AuthEnv>, result: PluginRouteResponse): Response {
  const status =
    Number.isInteger(result.status) && result.status! >= 200 && result.status! <= 599
      ? (result.status as 200)
      : 200;
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    if (!FORBIDDEN_HEADERS.has(key.toLowerCase()) && typeof value === 'string' && !/[\r\n]/.test(value)) {
      c.header(key, value);
    }
  }
  if (!c.res.headers.has('cache-control')) c.header('Cache-Control', 'no-store');
  if (result.json !== undefined) return c.json(result.json as never, status);
  if (result.text !== undefined) {
    return c.body(result.text, status, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  return c.body(null, status === 200 ? 204 : status);
}
