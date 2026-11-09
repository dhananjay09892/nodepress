# NodePress

**WordPress's ease and plugin ecosystem, on a modern JavaScript stack.**

NodePress is an open-source CMS written in TypeScript. Install it in one click, pick a theme, add plugins from the admin panel — or extend everything with hooks and use it headless.

> ⚠️ Early development. See [PLAN.md](./PLAN.md) for the full plan and roadmap.

## Getting started (development)

Requirements: Node.js 22+, pnpm 9+.

```bash
pnpm install
pnpm build
pnpm dev                                  # http://localhost:3000
```

- `GET /` — temporary front page (shows plugin filters in action)
- `GET /api/health` — kernel, database and plugin status
- `POST /api/v1/auth/login` — JSON `{ email, password }`; sets an HttpOnly session cookie and returns the user and a CSRF token
- `GET /api/v1/auth/me` — the signed-in user and CSRF token
- `POST /api/v1/auth/logout` — ends the session (send the CSRF token in `X-CSRF-Token`)

Personal API tokens let scripts and other services call the API without a browser session. Signed-in users manage their own tokens (cookie session and CSRF token required; a token cannot create or list tokens):

- `GET /api/v1/tokens` — list your tokens (name, created, last used, expiry; never the secret)
- `POST /api/v1/tokens` — JSON `{ name, expiresAt? }`; returns the secret **once** as `token`
- `DELETE /api/v1/tokens/:id` — revoke a token

Send a token as `Authorization: Bearer npt_…`. Tokens are stored only as SHA-256 hashes, can expire, and stop working when revoked or when their user is deleted. Bearer requests need no CSRF token; an invalid token is a `401` and never falls back to a cookie. Routes that accept either credential use the `authenticate` middleware from `createAuth()`.

Cookie-authenticated writes must send the CSRF token in the `X-CSRF-Token` header. Failed logins are rate limited (5 per email and 20 per address per 15 minutes). Session cookies are `Secure` and `__Host-` prefixed; for plain-HTTP local development set `COOKIE_SECURE=false`. Set `TRUST_PROXY=true` only behind a reverse proxy you control, so the client address is read from `X-Forwarded-For`.

The database is chosen by `DATABASE_URL`: `file:./nodepress.db` (SQLite, the default), `libsql://…` (Turso) or `postgres://user:pass@host:5432/db` (PostgreSQL). Migrations for each dialect ship in `packages/db/drizzle/<dialect>/`; after changing a schema run `pnpm --filter @nodepress/db db:generate`, which regenerates both.

Uploads are stored on local disk in `MEDIA_DIR` (default `./media`) and served from `/uploads/…`; `MAX_UPLOAD_BYTES` caps the file size (default 10 MiB). Allowed types: JPEG, PNG, GIF, WebP and PDF; SVG is blocked. The API is `POST /api/v1/media` (multipart `file` field, optional `alt`) plus list/get/patch/delete under the same path.

Other commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`.

## Repository layout

| Path                      | What it is                                                               |
| ------------------------- | ------------------------------------------------------------------------ |
| `packages/core`           | Kernel: typed hook system (actions & filters), plugin manager, lifecycle |
| `packages/sdk`            | Public API for plugin and theme authors (`definePlugin`, types)          |
| `packages/db`             | Drizzle schema v1 (SQLite/libSQL and PostgreSQL) and database client     |
| `apps/server`             | Hono HTTP server that boots a NodePress site                             |
| `plugins/hello-nodepress` | Minimal example plugin — copy it to start your own                       |

## Writing a plugin

```ts
import { definePlugin } from '@nodepress/sdk';

export default definePlugin({
  name: 'reading-time',
  setup({ hooks }) {
    hooks.addFilter('post:content', (html) => `<p>3 min read</p>${String(html)}`);
    hooks.addAction('core:ready', () => console.log('Plugin ready'));
  },
});
```

A plugin that throws during setup is marked as failed and its hooks are removed — the site keeps running.

## Status

- [ ] Phase 0 — Foundations _(in progress)_
- [ ] Phase 1 — Content core & API
- [ ] Phase 2 — Admin dashboard
- [ ] Phase 3 — Themes & front end
- [ ] Phase 4 — Plugin system
- [ ] Phase 5 — Install, deploy, migrate
- [ ] Phase 6 — Beta → 1.0

## License

[MIT](./LICENSE)
