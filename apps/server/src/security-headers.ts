import type { MiddlewareHandler } from 'hono';

/**
 * The default Content-Security-Policy for pages and the admin: everything from this site only,
 * inline styles allowed (themes and the editor use them), images from any https address and
 * `data:` (embedded images, remote media), embeds from https, no plugins, no `<base>` tricks,
 * forms only to this site, and framing only by this site (the customizer previews in a frame).
 * Scripts must come from this site; inline scripts are blocked.
 */
export const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' https:",
  'frame-src https:',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

export interface SecurityHeadersOptions {
  /** A policy, or `false` to send none (for example when a reverse proxy sets it). Default `DEFAULT_CSP`. */
  csp?: string | false;
  /**
   * `Strict-Transport-Security`: `auto` (default) sends it when the request came over HTTPS (or
   * when `trustProxy` is set and `X-Forwarded-Proto` says https); `false` never sends it.
   */
  hsts?: 'auto' | false;
  trustProxy?: boolean;
}

/** One year, and the subdomains too. Preload is left to the site owner. */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

/**
 * Adds the standard browser security headers to every response (cached pages, API answers and
 * errors included). A header a route set itself is left alone, so the uploads handler keeps its
 * own sandboxing policy.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): MiddlewareHandler {
  const csp = options.csp === undefined ? DEFAULT_CSP : options.csp;
  const hstsMode = options.hsts ?? 'auto';
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    const set = (name: string, value: string) => {
      if (!headers.has(name)) headers.set(name, value);
    };
    set('X-Content-Type-Options', 'nosniff');
    set('X-Frame-Options', 'SAMEORIGIN');
    set('Referrer-Policy', 'strict-origin-when-cross-origin');
    set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    set('Cross-Origin-Opener-Policy', 'same-origin');
    set('X-Permitted-Cross-Domain-Policies', 'none');
    if (csp !== false) set('Content-Security-Policy', csp);
    if (hstsMode === 'auto') {
      const forwarded = options.trustProxy
        ? c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
        : undefined;
      if (new URL(c.req.url).protocol === 'https:' || forwarded === 'https') {
        set('Strict-Transport-Security', HSTS_VALUE);
      }
    }
  };
}
