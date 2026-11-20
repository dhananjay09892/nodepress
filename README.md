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

The admin app lives in `apps/admin` (React, Vite, TanStack Router and Query, Tailwind) and is served by the server at `/admin` from `apps/admin/dist` (`ADMIN_DIR` overrides the folder). For a first sign-in during development, start the server with `ADMIN_EMAIL` and `ADMIN_PASSWORD`: while the site has no users, that administrator is created. For hot reload run `pnpm --filter @nodepress/admin dev` (http://localhost:5173, proxies the API to port 3000; start the server with `COOKIE_SECURE=false`). The Posts and Pages screens list content with search, a status filter, pagination and bulk publish/move-to-trash (through the content API). Each list has an Add new button and links every title to the edit screen (`/admin/posts/:id`, `/admin/pages/:id`): the block editor, title, status, publish date, slug and excerpt, a revision history with Restore (it brings back the title, text, slug and excerpt, never the status), and autosave for drafts only (published items are saved with the Update button, so half-written edits never go live). `GET /api/v1/content/:type/:id/revisions` lists an item's saved versions, newest first, for users who may edit it. The Users screen lists users with search and a role filter and edits a user's name, email and role (through `/api/v1/users`: `GET` list and item, `POST` create, `PATCH` edit; they need the `list_users`, `create_users` and `edit_users` capabilities, changing a role also needs `promote_users`, and nobody can change their own role). The Settings screens (General, Reading, Permalinks, at `/admin/settings`) edit the site title, tagline, time zone, front page, posts per page, search-engine visibility, post permalink pattern and the `api_public_read` switch through `GET`/`PATCH /api/v1/settings` (the `manage_options` capability; a fixed list of keys, each validated, and a bad value saves nothing). They are stored as options of the same name; the front page, posts per page, time zone and search-engine visibility are saved now and used by the theme work in Phase 3. The Media screen uploads files (file picker or drag and drop), shows them as a grid or list, and edits alt text or deletes a file (through the media API). `pnpm --filter @nodepress/admin e2e` runs the Playwright tests against a built server (first run: `pnpm --filter @nodepress/admin exec playwright install chromium`).

Plugins extend the admin through `context.admin` in `setup()`, with plain declarations (a plugin never runs code in the browser). `admin.addPage({ id, title, panels, capability? })` adds a page made of settings panels, each a list of `text`, `number`, `boolean`, `date` or `select` fields; `admin.addMenuItem({ id, label, page, order? })` links to it from the sidebar; `admin.getSettings(pageId, panelId)` reads the saved values (defaults filled in). A page needs `manage_options` unless the plugin sets another `capability`, and people without it neither see the menu item nor can open the page. Values are validated with the content field rules and stored as options named `admin-ext:<plugin>:<page>:<panel>` (never autoloaded), through `GET /api/v1/admin-extensions` (menu and pages for the signed-in user), `GET /api/v1/admin-extensions/:plugin/:page` and `PATCH /api/v1/admin-extensions/:plugin/:page/:panel`. `admin.addPostField({ field, contentTypes? })` adds a custom field to `post` and `page` (or the types named) through the `content-type:fields` filter, so the content API stores, validates and returns it in `meta`; the post edit screen reads the fields from `GET /api/v1/content-types` and draws a "Custom fields" panel for every text, number, boolean, date and single-choice select field that core has no panel for, saving only the changed ones through `meta`. Everything a plugin adds disappears when it is deactivated, and an invalid declaration fails only that plugin. `plugins/hello-nodepress` is the example: a Hello page where the closing line added to posts can be changed, and a `subtitle` field on posts.

Other commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`.

Themes are folders with a `theme.json` (`name` equal to the folder name, `version`, optional `title`, `description`, `supports`, `settings`, `templates` and `assets` folders) and templates named like WordPress ones: `page-{slug}` → `page` → `single` → `index` for pages, `single-{type}` → `single` → `index` for other content, `404` → `index` for the not-found page (`archive-{type}` and `front` are ready for the routes that will use them). A template is a TSX component (a default export, compiled to `.js`; Hono's JSX is used on the server) that receives `siteName`, `path`, `status`, `content`, `html` and `theme.assetsUrl` and returns markup; the `template:resolve` filter lets plugins change the list of names tried. Files in a theme's `assets` folder are served at `/themes/<name>/assets/…` with `Cache-Control` and an `ETag`. The server reads themes from `./themes` (`THEMES_DIR` overrides) and activates `THEME` (default `aurora`); a missing theme, a broken `theme.json` or a template that throws is logged and the built-in page is shown instead, so a theme can never take the site down. The front page `/` is drawn by the active theme's `front` (or `index`) template and receives the same props plus `tagline`, `posts` (the latest published posts, each with its `url`) and `settings` (the defaults from `theme.json` `settings`, with overrides checked against that schema; until the admin customizer exists, set overrides with `THEME_SETTINGS='{"layout":"business"}'`); without an active theme, or if the template fails, built-in markup is used. **Aurora** (`themes/aurora`) is the default theme (`THEME=aurora`): a blog layout (intro and post list) or a business layout (hero and news cards) chosen with its `layout` setting, responsive, with a skip link, landmarks and visible focus, and automatic dark mode through `prefers-color-scheme`. CI audits both layouts in light and dark with Lighthouse and requires an accessibility score of at least 95. Post bodies are not drawn by themes yet (N50).

Anonymous page views are cached (the front page, content pages, `/sitemap.xml` and `/feed.xml`; never the API, admin or theme files, and never a request with a session cookie, an `Authorization` header or a query string). The cache is in memory by default; set `PAGE_CACHE_DIR` to keep pages on disk instead, `PAGE_CACHE_TTL_SECONDS` to change how long a page may be served (default 600) or `PAGE_CACHE=off` to turn it off. Saving, publishing, trashing or deleting content and changing any option (site title, menus, widgets, theme settings) empties it, and replies carry `X-NodePress-Cache: hit` or `miss`. `/sitemap.xml` lists the front page and every published page and post; `/feed.xml` is an RSS 2.0 feed of the latest 20 posts. Set `SITE_URL` (for example `https://example.com`) so their links use your public address; without it the request's own origin is used.

Plugin packages are folders in `./plugins-installed` (`PLUGINS_DIR` overrides) with a `plugin.json` (`name` equal to the folder name, `version`, optional `title`, `description`, `permissions` and `entry`, default `index.js`) and a compiled entry module whose default export is a plugin made with `definePlugin`. A package found on disk is off until it is turned on (the `plugins` table keeps the flag and version; the admin screen for this is N28), and changes apply at the next start. `permissions` (`content:read`, `content:write`, `media:read`, `media:write`, `users:read`, `options:read`, `options:write`, `network`, `jobs`, `admin`, `database`) are declared so the owner can review them; they are not a sandbox, and only `database` is enforced (a package with a `migrations` folder must declare it). Migrations are `.sql` files in `migrations/sqlite/` and `migrations/postgres/`, run in file name order once each (split statements with `-- statement-breakpoint`; applied names are kept in the `plugin_migrations` option, and a failing file stops that plugin and is retried at the next start). A broken package is logged and skipped; the site still starts.

The admin **Plugins** screen (`manage_plugins`, administrators) lists the packages in the plugins folder with the permissions each declares, uploads a `.zip` (up to 20 MB; `plugin.json` at its top level or inside one folder), and turns packages on or off. Enabling asks first and shows the permissions again. The server unpacks uploads with a strict reader (no encrypted, zip64 or symbolic-link entries, no `..` or absolute paths, size and entry limits), checks the package like discovery does, and moves it into place without overwriting an installed plugin; a new package is off until enabled. The same actions are on `GET`/`POST /api/v1/plugins` (raw `application/zip` body) and `PATCH /api/v1/plugins/:name` (`{"enabled": true}`). Plugin code loads when the site starts, so the screen says when a restart is needed (`restartRequired`).

The WordPress importer lives in `@nodepress/core` (`importWordPress`): it reads a WXR export (no dependencies, size and nesting limits), creates categories (parents first), tags, posts and pages, converts the HTML to blocks (paragraphs, headings, lists, quotes, code, images and inline marks; scripts and unsafe links are dropped; classic content without `<p>` is split on blank lines), keeps the WordPress id, link and comments as content meta, maps statuses (`future` dates in the past go live), rewrites links between imported items (including `?p=ID`) to their new URLs, and returns the redirect map (old path → new path) plus the list of files it did not download. Authors are matched through a `resolveAuthor` callback or `defaultAuthorId`. One bad item is reported in `skipped` and the rest still import. There is no HTTP endpoint or admin screen for it yet (N55).

Menus: a theme declares where it draws navigation in `theme.json` (`"menus": { "primary": "Primary menu" }`; `widgetAreas` is accepted the same way and is used by N52). Menus are kept in the options table and managed through `/api/v1/menus` (`GET`/`POST`, `GET`/`PATCH`/`DELETE /:id`) and `/api/v1/menu-locations` (`GET`, and `PUT` with `{ "primary": 3 }` to assign or `null` to clear), all needing the `edit_theme_options` capability (administrators). A menu is a tree of links up to 3 levels deep and 200 items, each with a `label`, a `url` (a site path, `http(s)`, `mailto:` or `tel:`; `javascript:` and similar are refused) and an optional `target: "_blank"`. Templates receive the assigned menus as `menus` (location name to items; unassigned locations are absent), and Aurora draws `primary` in the header and `footer` below the content. The admin Menus screen is N51.

## Repository layout

| Path                      | What it is                                                               |
| ------------------------- | ------------------------------------------------------------------------ |
| `packages/core`           | Kernel: typed hook system (actions & filters), plugin manager, lifecycle |
| `packages/sdk`            | Public API for plugin and theme authors (`definePlugin`, types)          |
| `packages/db`             | Drizzle schema v1 (SQLite/libSQL and PostgreSQL) and database client     |
| `packages/editor`         | Block model, block registry, core blocks and server-side HTML renderer   |
| `apps/server`             | Hono HTTP server that boots a NodePress site                             |
| `apps/admin`              | React admin dashboard, served by the server at `/admin`                  |
| `themes/aurora`           | Default theme: blog and business layouts, responsive, dark mode          |
| `themes/starter`          | Minimal example theme in TSX — copy it to start your own                 |
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
