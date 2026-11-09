import {
  ApiTokenValidationError,
  MAX_PASSWORD_LENGTH,
  RateLimiter,
  verifyCsrfToken,
  type ApiToken,
  type ApiTokensService,
  type SessionRecord,
  type SessionsService,
  type User,
  type UsersService,
} from '@nodepress/core';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

/** Who is making a cookie-authenticated request. */
export interface AuthContext {
  user: User;
  session: SessionRecord;
  csrfToken: string;
  /** The raw cookie value, kept so logout can end exactly this session. */
  token: string;
}

/** Who is making a request, however they proved it. Set by the `authenticate` middleware. */
export type Principal =
  { via: 'session'; user: User } | { via: 'token'; user: User; token: ApiToken };

export interface AuthEnv {
  Variables: { auth: AuthContext | null; principal: Principal | null };
}

export interface AuthOptions {
  users: Pick<UsersService, 'authenticate'>;
  sessions: SessionsService;
  /** Enables personal API tokens: Bearer authentication and the `/api/v1/tokens` routes. */
  apiTokens?: ApiTokensService;
  /** Send the cookie with `Secure` and the `__Host-` prefix. Default true; turn off only for plain-HTTP development. */
  secureCookies?: boolean;
  /** Read the client address from the last `X-Forwarded-For` entry. Only enable behind a proxy you control. */
  trustProxy?: boolean;
  /** Failed logins allowed per client address per window (default 20 per 15 minutes). */
  loginLimitByIp?: RateLimiter;
  /** Failed logins allowed per email per window (default 5 per 15 minutes). */
  loginLimitByEmail?: RateLimiter;
  /** Extra origins (for example an admin served from another host) allowed to send cookie-authenticated writes. */
  allowedOrigins?: string[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER = 'x-csrf-token';
const MAX_BODY_BYTES = 8 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export interface Auth {
  /** Routes for `/api/v1/auth` (login, logout, me). */
  routes: Hono<AuthEnv>;
  /** Loads the session from the cookie into `c.var.auth` (null when absent or invalid). Never rejects. */
  loadSession: MiddlewareHandler<AuthEnv>;
  /** Rejects with 401 without a session and 403 for a write without a valid CSRF token. Use after `loadSession`. */
  requireAuth: MiddlewareHandler<AuthEnv>;
  /** Rejects writes whose `Origin` header names another site. */
  originGuard: MiddlewareHandler<AuthEnv>;
  /**
   * For API routes that accept either credential. A valid `Authorization: Bearer` token
   * authenticates without CSRF checks (a browser never attaches it by itself); an invalid
   * one is a 401 and never falls back to the cookie. Without a Bearer header it behaves like
   * `loadSession` + `requireAuth`. Sets `c.var.principal`.
   */
  authenticate: MiddlewareHandler<AuthEnv>;
  /** Routes for `/api/v1/tokens` (list, create, revoke). Cookie sessions only, never tokens. */
  tokenRoutes: Hono<AuthEnv>;
  cookieName: string;
}

export function createAuth(options: AuthOptions): Auth {
  const secure = options.secureCookies ?? true;
  const cookieName = secure ? '__Host-np_session' : 'np_session';
  const byIp = options.loginLimitByIp ?? new RateLimiter({ max: 20, windowMs: LOGIN_WINDOW_MS });
  const byEmail =
    options.loginLimitByEmail ?? new RateLimiter({ max: 5, windowMs: LOGIN_WINDOW_MS });
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((o) => o.toLowerCase()));

  const loadSession: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const token = getCookie(c, cookieName);
    const active = await options.sessions.validate(token);
    c.set(
      'auth',
      active && token
        ? { user: active.user, session: active.session, csrfToken: active.csrfToken, token }
        : null,
    );
    await next();
  };

  const originGuard: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin !== undefined && !originAllowed(c, origin, allowedOrigins)) {
        return c.json({ error: 'forbidden_origin' }, 403);
      }
    }
    await next();
  };

  const csrfOk = (c: Context<AuthEnv>, auth: AuthContext): boolean =>
    SAFE_METHODS.has(c.req.method) || verifyCsrfToken(auth.session.id, c.req.header(CSRF_HEADER));

  const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'unauthenticated' }, 401);
    if (!csrfOk(c, auth)) return c.json({ error: 'csrf_failed' }, 403);
    await next();
  };

  const clearCookie = (c: Context<AuthEnv>): void => {
    deleteCookie(c, cookieName, { path: '/', secure });
  };

  const bearerChallenge = (c: Context<AuthEnv>, error?: string) => {
    c.header('WWW-Authenticate', error ? `Bearer error="${error}"` : 'Bearer');
    return c.json({ error: error ?? 'unauthenticated' }, 401);
  };

  /** The secret from `Authorization: Bearer <token>`, `null` when no Bearer header is present. */
  const bearerToken = (c: Context<AuthEnv>): string | null => {
    const match = /^Bearer[ \t]+(\S*)[ \t]*$/i.exec(c.req.header('authorization') ?? '');
    return match ? match[1]! : null;
  };

  const authenticate: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const bearer = bearerToken(c);
    if (bearer !== null) {
      if (!options.apiTokens) return bearerChallenge(c, 'invalid_token');
      const result = await options.apiTokens.authenticate(bearer);
      if (!result) return bearerChallenge(c, 'invalid_token');
      c.set('principal', { via: 'token', user: result.user, token: result.token });
      return next();
    }
    await loadSession(c, async () => {});
    const auth = c.get('auth');
    if (!auth) return bearerChallenge(c);
    if (!csrfOk(c, auth)) return c.json({ error: 'csrf_failed' }, 403);
    c.set('principal', { via: 'session', user: auth.user });
    return next();
  };

  const tokenRoutes = new Hono<AuthEnv>();
  tokenRoutes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  tokenRoutes.use('*', originGuard);
  tokenRoutes.use('*', loadSession);
  tokenRoutes.use('*', requireAuth);
  tokenRoutes.use('*', async (c, next) => {
    if (!options.apiTokens) return c.json({ error: 'not_found' }, 404);
    await next();
  });

  tokenRoutes.get('/', async (c) => {
    const tokens = await options.apiTokens!.list(c.get('auth')!.user.id);
    return c.json({ tokens: tokens.map(publicToken) });
  });

  tokenRoutes.post('/', async (c) => {
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
    const { name, expiresAt } = (body ?? {}) as { name?: unknown; expiresAt?: unknown };
    if (typeof name !== 'string') return c.json({ error: 'invalid_request' }, 400);
    let expires: Date | null = null;
    if (expiresAt !== undefined && expiresAt !== null) {
      expires = typeof expiresAt === 'string' ? new Date(expiresAt) : new Date(Number.NaN);
      if (Number.isNaN(expires.getTime())) {
        return c.json({ error: 'invalid_request', message: 'expiresAt must be an ISO date' }, 400);
      }
    }
    try {
      const created = await options.apiTokens!.create(c.get('auth')!.user.id, {
        name,
        expiresAt: expires,
      });
      // The secret appears in this response and nowhere else.
      return c.json({ token: created.token, record: publicToken(created.record) }, 201);
    } catch (error) {
      if (error instanceof ApiTokenValidationError) {
        return c.json({ error: 'invalid_request', message: error.message }, 400);
      }
      throw error;
    }
  });

  tokenRoutes.delete('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'not_found' }, 404);
    const removed = await options.apiTokens!.revoke(c.get('auth')!.user.id, id);
    return removed ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  const routes = new Hono<AuthEnv>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use('*', originGuard);
  routes.use('*', loadSession);

  routes.post('/login', async (c) => {
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
    const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };
    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      email.length === 0 ||
      password.length === 0 ||
      email.length > 254 ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const ipKey = `ip:${clientIp(c, options.trustProxy ?? false)}`;
    const emailKey = `email:${email.trim().toLowerCase()}`;
    const limits = [byIp.check(ipKey), byEmail.check(emailKey)];
    const blocked = limits.filter((l) => !l.allowed);
    if (blocked.length > 0) {
      const wait = Math.max(...blocked.map((l) => l.retryAfterMs));
      c.header('Retry-After', String(Math.max(1, Math.ceil(wait / 1000))));
      return c.json({ error: 'rate_limited' }, 429);
    }

    const user = await options.users.authenticate(email, password);
    if (!user) {
      byIp.fail(ipKey);
      byEmail.fail(emailKey);
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    byEmail.reset(emailKey);

    // Always start a fresh session at login, and end any old one (prevents session fixation).
    await options.sessions.destroy(getCookie(c, cookieName));
    const created = await options.sessions.create(user.id);
    setCookie(c, cookieName, created.token, {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      expires: created.expiresAt,
      maxAge: Math.floor(options.sessions.ttlMs / 1000),
    });
    return c.json({
      user: publicUser(user),
      csrfToken: created.csrfToken,
      expiresAt: created.expiresAt.toISOString(),
    });
  });

  routes.post('/logout', async (c) => {
    const auth = c.get('auth');
    if (auth) {
      if (!csrfOk(c, auth)) return c.json({ error: 'csrf_failed' }, 403);
      await options.sessions.destroy(auth.token);
    }
    clearCookie(c);
    return c.body(null, 204);
  });

  routes.get('/me', async (c) => {
    const bearer = bearerToken(c);
    if (bearer !== null) {
      const result = options.apiTokens ? await options.apiTokens.authenticate(bearer) : null;
      if (!result) return bearerChallenge(c, 'invalid_token');
      return c.json({ user: publicUser(result.user), tokenId: result.token.id });
    }
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'unauthenticated' }, 401);
    return c.json({ user: publicUser(auth.user), csrfToken: auth.csrfToken });
  });

  return { routes, loadSession, requireAuth, originGuard, authenticate, tokenRoutes, cookieName };
}

function publicToken(token: ApiToken) {
  return {
    id: token.id,
    name: token.name,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    expiresAt: token.expiresAt?.toISOString() ?? null,
  };
}

function publicUser(user: User) {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}

function originAllowed(c: Context<AuthEnv>, origin: string, allowed: Set<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // includes the literal "null" origin
  }
  if (allowed.has(parsed.origin.toLowerCase())) return true;
  const host = c.req.header('host') ?? new URL(c.req.url).host;
  return parsed.host.toLowerCase() === host.toLowerCase();
}

function clientIp(c: Context<AuthEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (forwarded) return forwarded;
  }
  const env = c.env as unknown as
    { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}
