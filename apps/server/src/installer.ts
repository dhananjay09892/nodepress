import { timingSafeEqual } from 'node:crypto';
import {
  DuplicateEmailError,
  isEmailAddress,
  RateLimiter,
  SettingValidationError,
  UserValidationError,
  type Logger,
  type SettingsService,
  type UsersService,
} from '@nodepress/core';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import {
  INSTALL_PAGE,
  INSTALL_SCRIPT,
  INSTALL_SCRIPT_PATH,
  INSTALL_STYLE,
  INSTALL_STYLE_PATH,
  MIN_ADMIN_PASSWORD,
} from './installer-page.js';

export interface InstallerOptions {
  users: Pick<UsersService, 'list' | 'create'>;
  settings: Pick<SettingsService, 'update'>;
  /** Shown in the database check. */
  dialect: string;
  /** The code that proves the visitor has access to the server (its log or environment). */
  code: string;
  /** Called after the administrator exists, with the name chosen for the site. */
  onInstalled?: (info: { siteName: string }) => void | Promise<void>;
  logger?: Logger;
  now?: () => number;
}

export interface Installer {
  routes: Hono;
  /** Sends visitors of a site without users to the wizard. Mount before the other routes. */
  redirect: MiddlewareHandler;
  needsSetup(): Promise<boolean>;
}

const MAX_BODY_BYTES = 8 * 1024;

function sameCode(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The web installer for a fresh site (no users yet):
 * - `GET /install`: the wizard (database check, site name, administrator).
 * - `GET /api/v1/install/status`: `{ needsSetup, database: { dialect, ok } }`.
 * - `POST /api/v1/install` (JSON `{ code, siteName, email, password }`): creates the first
 *   administrator and sets the site name. The `code` is printed in the server log at start (or
 *   given as `INSTALL_CODE`), so only someone with access to the server can set the site up;
 *   wrong codes are rate limited. Once a user exists every route answers "already installed"
 *   and visitors are no longer redirected.
 */
export function createInstaller(options: InstallerOptions): Installer {
  const limiter = new RateLimiter({
    max: 10,
    windowMs: 15 * 60 * 1000,
    ...(options.now ? { now: options.now } : {}),
  });
  let installed = false;
  let running = false;

  async function needsSetup(): Promise<boolean> {
    if (installed) return false;
    try {
      if ((await options.users.list()).length > 0) installed = true;
    } catch {
      // The database is not usable: the wizard says so. Nothing can be installed either.
      return true;
    }
    return !installed;
  }

  const redirect: MiddlewareHandler = async (c, next) => {
    if (installed || c.req.method !== 'GET') return next();
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/install') || path.startsWith('/api/')) return next();
    if (!(await needsSetup())) return next();
    return c.redirect('/install', 302);
  };

  const routes = new Hono();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  routes.get('/install', async (c) => {
    if (!(await needsSetup())) return c.redirect('/admin/', 302);
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(INSTALL_PAGE);
  });
  routes.get(INSTALL_SCRIPT_PATH, (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    return c.body(INSTALL_SCRIPT);
  });

  routes.get(INSTALL_STYLE_PATH, (c) => {
    c.header('Content-Type', 'text/css; charset=utf-8');
    return c.body(INSTALL_STYLE);
  });

  routes.get('/api/v1/install/status', async (c) => {
    const needed = await needsSetup();
    if (!needed) return c.json({ needsSetup: false });
    let ok = true;
    try {
      await options.users.list();
    } catch {
      ok = false;
    }
    return c.json({ needsSetup: true, database: { dialect: options.dialect, ok } });
  });

  routes.post('/api/v1/install', async (c: Context) => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    if (!(await needsSetup())) return c.json({ error: 'already_installed' }, 409);
    const status = limiter.check('code');
    if (!status.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(status.retryAfterMs / 1000))));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    if (typeof body.code !== 'string' || !sameCode(body.code.trim(), options.code)) {
      limiter.fail('code');
      return c.json({ error: 'bad_code' }, 400);
    }

    const fields: Record<string, string> = {};
    const siteName = typeof body.siteName === 'string' ? body.siteName.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!siteName) fields.siteName = 'Enter a name for your site.';
    else if (siteName.length > 200) fields.siteName = 'Use at most 200 characters.';
    if (!isEmailAddress(email)) fields.email = 'Enter a valid email address.';
    if (password.length < MIN_ADMIN_PASSWORD) {
      fields.password = `Use at least ${MIN_ADMIN_PASSWORD} characters.`;
    }
    if (Object.keys(fields).length > 0) return c.json({ error: 'invalid_request', fields }, 400);

    if (running) return c.json({ error: 'install_running' }, 409);
    running = true;
    try {
      if (!(await needsSetup())) return c.json({ error: 'already_installed' }, 409);
      try {
        // The name first: if it fails no account exists yet and the wizard can simply be sent again.
        await options.settings.update({ site_title: siteName });
        await options.users.create({
          email,
          password,
          displayName: 'Administrator',
          role: 'administrator',
        });
      } catch (error) {
        if (error instanceof DuplicateEmailError || error instanceof UserValidationError) {
          return c.json({ error: 'invalid_request', fields: { email: error.message } }, 400);
        }
        if (error instanceof SettingValidationError) {
          return c.json({ error: 'invalid_request', fields: { siteName: error.message } }, 400);
        }
        throw error;
      }
      installed = true;
      limiter.reset('code');
      options.logger?.info('Setup finished: the administrator account was created');
      await options.onInstalled?.({ siteName });
      return c.json({ ok: true }, 201);
    } finally {
      running = false;
    }
  });

  return { routes, redirect, needsSetup };
}
