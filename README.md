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
- `GET /admin/` — the admin dashboard (build it first with `pnpm build`; sign-in uses the auth API below)
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

Content is available for every registered content type (`post`, `page` and any type a plugin adds) under `/api/v1/content/:type`. Authenticate with a Bearer API token (or a session cookie plus CSRF token). Every route checks the user's capabilities, and non-published items are visible only to their author and to users who may edit others' items:

- `GET /api/v1/content/:type` — list. Query: `status` (comma-separated), `author` (id or `me`), `slug`, `q` (title search), `sort` (`id`, `title`, `createdAt`, `updatedAt`, `publishedAt`; prefix `-` for descending), `limit` (1–100, default 20), `offset`, `fields` (comma-separated). Returns `{ items, total, limit, offset }`
- `GET /api/v1/content/:type/:id` — one item (also accepts `fields`)
- `POST /api/v1/content/:type` — create; JSON `{ title, slug?, status?, body?, excerpt?, authorId?, parentId?, publishedAt?, meta?, terms? }`
- `PATCH /api/v1/content/:type/:id` — update the fields you send
- `DELETE /api/v1/content/:type/:id` — move to the trash; delete a trashed item (or pass `?force=true`) to remove it for good
- `GET /api/v1/content-types` — the registered types
- `GET /api/v1/openapi.json` — OpenAPI 3.1 description (public)

Custom fields and terms travel with the item. `meta` holds the values of the fields the content type defines (validated by the content type registry: required fields and defaults apply on create, an update changes only the fields it sends, and `null` clears a field that is not required). `terms` maps a taxonomy name (`category`, `tag`, or a plugin's) to the ids of the terms the item should have in it, replacing that taxonomy's terms; it needs the `manage_categories` capability. A single item always comes back with `meta` and `terms`; a list includes them only when named in `fields` (for example `fields=id,title,meta,terms`).

Headless sites can read published content without a token: set the `api_public_read` option to `true` (off by default) and anonymous `GET`s of `/api/v1/content/:type` and `/api/v1/content/:type/:id` return published items only. Requests that send a token or cookie are still checked, and every other route still needs credentials.

Plugins can reshape every successful response with the `api:response` filter (its `user` is `null` for an anonymous read).

Uploads are stored on local disk in `MEDIA_DIR` (default `./media`) and served from `/uploads/…`; `MAX_UPLOAD_BYTES` caps the file size (default 10 MiB). Allowed types: JPEG, PNG, GIF, WebP and PDF; SVG is blocked. The API is `POST /api/v1/media` (multipart `file` field, optional `alt`) plus list/get/patch/delete under the same path.

Webhooks are off until `WEBHOOK_SIGNING_KEY` (32+ characters, kept out of the database) is set. Administrators (`manage_options`) manage them under `/api/v1/webhooks` (list, create, patch, delete, `POST /:id/rotate-secret`, `POST /:id/test`). Events: `content.created`, `content.updated`, `content.published`, `content.trashed`, `content.deleted` (or `*`). Each delivery is a JSON `POST` with `X-NodePress-Event`, `X-NodePress-Delivery`, `X-NodePress-Timestamp` and `X-NodePress-Signature: v1=<HMAC-SHA256 hex of "<timestamp>.<body>">`, retried with backoff (6 tries) until the endpoint answers 2xx. The secret is shown once, when the webhook is created or rotated; `verifyWebhookSignature()` from `@nodepress/core` checks a request. URLs that point at loopback or private networks are refused (set `WEBHOOK_ALLOW_PRIVATE=true` for local development).

The admin app lives in `apps/admin` (React, Vite, TanStack Router and Query, Tailwind) and is served by the server at `/admin` from `apps/admin/dist` (`ADMIN_DIR` overrides the folder). For a first sign-in during development, start the server with `ADMIN_EMAIL` and `ADMIN_PASSWORD`: while the site has no users, that administrator is created. For hot reload run `pnpm --filter @nodepress/admin dev` (http://localhost:5173, proxies the API to port 3000; start the server with `COOKIE_SECURE=false`). The Posts and Pages screens list content with search, a status filter, pagination and bulk publish/move-to-trash (through the content API). The Media screen uploads files (file picker or drag and drop), shows them as a grid or list, and edits alt text or deletes a file (through the media API). `pnpm --filter @nodepress/admin e2e` runs the Playwright tests against a built server (first run: `pnpm --filter @nodepress/admin exec playwright install chromium`).

Other commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`.

## Repository layout

| Path                      | What it is                                                               |
| ------------------------- | ------------------------------------------------------------------------ |
| `packages/core`           | Kernel: typed hook system (actions & filters), plugin manager, lifecycle |
| `packages/sdk`            | Public API for plugin and theme authors (`definePlugin`, types)          |
| `packages/db`             | Drizzle schema v1 (SQLite/libSQL and PostgreSQL) and database client     |
| `packages/editor`         | Block model, block registry, core blocks and server-side HTML renderer   |
| `apps/server`             | Hono HTTP server that boots a NodePress site                             |
| `apps/admin`              | React admin dashboard, served by the server at `/admin`                  |
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
