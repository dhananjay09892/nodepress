# Security policy

NodePress is early software (see [PLAN.md](./PLAN.md)). There are no supported releases yet; fixes go into `main`.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting for this repository (Security tab, "Report a vulnerability"). Include what you found, how to reproduce it and which commit you tested. You will get an answer as soon as the maintainer can read it; there is no service-level promise yet.

## What NodePress does today

- **Sessions and API tokens:** session cookies are `HttpOnly`, `Secure`, `SameSite` and `__Host-` prefixed; writes made with a cookie need a CSRF token; personal API tokens and session ids are stored only as hashes; passwords are hashed with Argon2.
- **Login and forms:** failed logins are rate limited per email and per address; the public contact form has a honeypot, a signed time token and a per-address limit. Limits are kept in memory per server process.
- **Database:** every query is parameterized (Drizzle); plugin migrations are the one place raw SQL runs, and a package with migrations must declare the `database` permission.
- **Uploads:** the type is detected from the file's bytes and must match what the client claimed, size and pixel counts are limited, and files are served with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`; PDFs download instead of opening.
- **Browser headers:** every response carries a Content-Security-Policy (scripts only from this site, no plugins, no `<base>`, framing only by this site), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and `Strict-Transport-Security` over HTTPS. `CONTENT_SECURITY_POLICY` replaces the policy (`off` sends none) and `HSTS=off` turns HSTS off.
- **Plugins:** a plugin package declares the permissions it needs and the owner sees them before turning it on. **This is not a sandbox**: an active plugin runs with the full rights of the server, so install plugins only from sources you trust. An uploaded `.zip` is read with a strict reader (no encrypted, zip64 or symbolic-link entries, no paths that leave the folder, size and entry limits).
- **Webhooks and redirects:** webhook targets are checked against private and loopback addresses; redirect rules cannot point a site path at another site by accident (`//host`) and cannot cover `/api`, `/admin` or `/uploads`.
- **Secrets:** nothing secret is committed; the installer writes `.env` readable by its owner only.

## Known limits

- Rate limits are per process; behind several server instances each counts separately.
- Plugins are trusted code (see above).
- Themes are code too: a theme's templates run on the server.
- No security review by a third party has been done.
