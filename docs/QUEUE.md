# NodePress build queue

The daily builder (a Claude scheduled task) takes **one task per run**, top to bottom, and delivers it as a pull request titled `[Daily] Nnn: <title>` from a branch `daily/Nnn-short-name`.

**Status is not stored in this file.** It comes from GitHub:

- **done**: a merged PR whose title starts with `[Daily] Nnn`
- **in review**: an open one
- **rejected**: closed without merging (never retried)

**Rules**

- Order is priority. The builder picks the first task that is not done, in review or rejected, has no `Needs you:` marker, and whose dependencies are all merged.
- A task marked `Needs you: …` is skipped until the owner removes the marker.
- Every task must fit one reviewable PR (roughly under 800 changed lines, excluding lockfile and migrations). If it doesn't, the builder delivers a working first slice and inserts a follow-up task right after it, in the same PR.
- The owner may edit, reorder, add or delete tasks at any time.

---

## Phase 0: Foundations (remainder)

### N01 · PostgreSQL schema and dialect selection

- Depends on: none
- Scope: Postgres variant of the v1 schema in `packages/db` (same tables and columns), `createDatabase()` picks the dialect from the URL (`postgres://` vs `file:`/`libsql:`), separate migration folders per dialect, drizzle config per dialect.
- Done when: both dialects build and type-check; unit tests cover dialect selection; CI runs migrations against SQLite and a Postgres service container.

## Phase 1: Content core & API

### N02 · Options (settings) service

- Depends on: N01
- Scope: `packages/core` service to get/set typed options stored in `options`, in-memory cache of autoloaded options, `option:updated` action, `option:value` filter.
- Done when: unit tests against in-memory SQLite pass.

### N03 · Users, password hashing, roles and capabilities

- Depends on: N02
- Scope: user service (create, update, find, delete), Argon2 hashing, the five default roles, capability map with `can(user, capability)`, filter so plugins can add capabilities.
- Done when: tests cover hashing, role defaults and capability checks.

### N04 · Sessions, login and logout

- Depends on: N03
- Scope: session cookies (HttpOnly, Secure, SameSite), `POST /api/v1/auth/login|logout`, `GET /api/v1/auth/me`, CSRF protection for cookie-authenticated writes, login rate limiting.
- Done when: API tests cover success, wrong password, rate limit and CSRF rejection.

### N05 · API tokens

- Depends on: N04
- Scope: create, list and revoke personal API tokens (hashed at rest), Bearer auth middleware.
- Done when: tests cover token auth and revocation.

### N06 · Content service with revisions

- Depends on: N03
- Scope: create, read, update, trash and delete content; unique slug generation; statuses; a revision saved on every update; `post:saving` filter and `post:saved` / `post:published` actions.
- Done when: unit tests cover slugs, statuses, revisions and hooks.

### N07 · Content type and field registry

- Depends on: N06
- Scope: `registerContentType()` and field definitions (text, rich text, number, boolean, date, select, media, relation) validated with Zod; built-in `post` and `page`; plugins can register types through hooks.
- Done when: tests cover registration, validation errors and the plugin path.

### N08 · Taxonomies

- Depends on: N06
- Scope: categories, tags and custom taxonomies; assign terms to content; hierarchical terms.
- Done when: tests cover CRUD and assignment.

### N09 · Permalinks and front-end resolver

- Depends on: N06, N02
- Scope: configurable permalink patterns, URL → content resolution, 404 handling, redirect when a slug changes.
- Done when: tests cover patterns and slug-change redirects.

### N10 · Job queue and scheduled publishing

- Depends on: N06
- Scope: DB-backed job runner (claim, retry with backoff, failure record), `registerJob()` API for plugins, scheduled posts publish on time.
- Done when: tests cover retry and scheduled publish (with fake timers).

### N11 · Media uploads

- Depends on: N04
- Scope: multipart upload endpoint, type and size checks, `sharp` variants (thumbnail, medium, large, WebP), local storage adapter behind a storage interface.
- Done when: tests cover allowed and blocked types and variant generation.

### N12 · REST API v1 for content

- Depends on: N07, N08, N05
- Scope: auto-generated routes for every content type (list with filter, sort, pagination and field selection; get; create; update; delete) with capability checks; `api:response` filter; OpenAPI document at `/api/v1/openapi.json`.
- Done when: API tests cover each route and permission denial.

### N43 · Content API: custom fields, terms and public reads

- Depends on: N12
- Scope: follow-up to N12. Store and return custom field values (the `content_meta` table, validated by the content type registry) through the content routes; assign and return taxonomy terms (`categories`, `tags`, custom taxonomies) on create/update/get with `manage_categories` checks; optional anonymous `GET` of published items for headless sites (off by default, a setting turns it on); document all of it in the OpenAPI document.
- Done when: API tests cover field validation errors, term assignment and permission denial, and anonymous reads when enabled and disabled.

### N13 · Webhooks

- Depends on: N12, N10
- Scope: configurable webhooks on content events, signed payloads (HMAC), delivered through the job queue with retries.
- Done when: tests cover signing and retry.

## Phase 2: Admin dashboard

### N14 · Admin app scaffold

- Depends on: N04
- Scope: `apps/admin` (Vite, React, TanStack Router and Query, Tailwind), login screen, app shell with sidebar, served by the server at `/admin`.
- Done when: the admin builds, login works against the API, and a Playwright smoke test passes in CI.

### N15 · Posts and pages list screens

- Depends on: N14, N12
- Scope: list with search, status filter, pagination and bulk trash/publish.
- Done when: Playwright test covers listing and a bulk action.

### N16 · Editor engine decision record

- Depends on: N14
- Scope: spike Lexical vs Tiptap (block model, JSON storage, extension API, bundle size, licence, accessibility); write `docs/adr/0001-editor.md` with a recommendation; leave the `Decision:` line empty.
- Done when: ADR merged.

### N17 · Block editor with core blocks

- Depends on: N16
- Scope: `packages/editor` with block registry and core blocks (paragraph, heading, image, list, quote, code, embed, columns, button); stores JSON blocks; server-side renderer to HTML.
- Done when: unit tests for rendering pass. (The admin editor UI moved to N44.)

### N44 · Admin block editor UI (Tiptap)

- Depends on: N17
- Scope: follow-up to N17, which delivered the editor-independent block model, registry, core blocks, validation and server-side renderer in `packages/editor`. Add the Tiptap (MIT packages only) integration in `packages/editor` (the only package that imports Tiptap): one extension per core block, conversion between Tiptap JSON and the NodePress block envelope, a React `BlockEditor` component, and use it in the admin on a temporary route. Record the real bundle size and the server-render round-trip in `docs/adr/0001-editor.md` and replace its **(verify)** markers. Needs npm access to install `@tiptap/*`.
- Done when: round-trip tests (envelope to Tiptap to envelope) pass for every core block, and the editor works in the admin.

### N45 · Editor measurements and ADR verification

- Depends on: N44
- Scope: follow-up to N44, whose environment could not build or run the editor. Build the admin, record the real gzip size of the editor chunk, run the server-render round-trip, check keyboard-only use of the toolbar, and replace every **(verify)** marker in `docs/adr/0001-editor.md` with the measured result. Fix anything the first real build or Playwright run of N44 turns up.
- Done when: no **(verify)** markers remain in the ADR and the editor Playwright test is green in CI.

### N18 · Post edit screen

- Depends on: N44, N15
- Scope: editor plus sidebar (status, publish date, slug, excerpt, categories, tags, featured image), autosave, revision history view.
- Done when: Playwright test writes and publishes a post.

### N46 · Post edit sidebar: categories, tags and featured image

- Depends on: N18
- Scope: follow-up to N18, which delivered the edit screen (editor, status, publish date, slug, excerpt, draft autosave, revision history) and `GET /api/v1/content/:type/:id/revisions`. Add the remaining sidebar panels: categories (hierarchical checklist) and tags (type-ahead, create on the fly) through the `terms` field of the content API (needs the `manage_categories` capability; hide the panels without it), and a featured image picker that reuses the media library (stored as a `featured_image` custom field on the content types, registered by core). Show a diff of title and text between the current form and a chosen revision.
- Done when: Playwright test assigns a category and a tag and sets a featured image on a post.

### N19 · Media library screen

- Depends on: N14, N11
- Scope: grid/list, upload by drag-and-drop, edit alt text, delete.
- Done when: Playwright test uploads an image.

### N20 · Users and settings screens

- Depends on: N14, N03, N02
- Scope: users list and edit (roles), general/reading/permalink settings screens.
- Done when: Playwright tests cover changing a role and a setting.

### N47 · Settings screens: general, reading and permalinks

- Depends on: N20
- Scope: follow-up to N20, which delivered the users API (`/api/v1/users`: list, read, create, edit name, email and role) and the Users screen. Add a settings API (`GET`/`PATCH /api/v1/settings`, `manage_options` only, a fixed list of known keys validated per key: site title, tagline, timezone, front page and posts per page, search-engine visibility, permalink pattern from N09, `api_public_read`) and the Settings screens (General, Reading, Permalinks) in the admin, saving through the options service.
- Done when: API tests cover validation and permission denial, and a Playwright test changes a setting and sees it persisted after a reload.

### N48 · Users: add, delete and reset password

- Depends on: N20
- Scope: follow-up to N20. Add the admin UI to create a user (`POST /api/v1/users` already exists), delete a user with a confirmation (new `DELETE /api/v1/users/:id`, `delete_users`, never yourself, reassign or keep their content as `authorId = null`), and set a new password for a user (`password` on `PATCH`, `edit_users`; ends that user's sessions).
- Done when: API tests cover delete and password reset (including sessions ended), and a Playwright test adds and deletes a user.

### N21 · Admin extension points

- Depends on: N20
- Scope: plugins can add admin menu items, pages, settings panels and custom fields in the post sidebar.
- Done when: the example plugin adds a settings page, covered by a test.

## Phase 3: Themes & front end

### N22 · Theme loader and template hierarchy

- Depends on: N09
- Scope: `theme.json` manifest, theme discovery, TSX templates rendered on the server, template hierarchy (`single-{type}` → `single` → `index`), theme assets served with cache headers.
- Done when: tests cover hierarchy resolution and rendering.

### N23 · Default theme "Aurora"

- Depends on: N22
- Scope: blog and business layouts, responsive, accessible (WCAG 2.1 AA), dark mode; replaces the temporary front page.
- Done when: Lighthouse accessibility ≥ 95 in CI.

### N24 · Menus and widget areas

- Depends on: N22, N20
- Scope: menu builder API and admin screen, theme-declared menu locations and widget areas.
- Done when: tests and a Playwright test cover creating a menu.

### N25 · Theme customizer with live preview

- Depends on: N23
- Scope: theme settings schema (colors, fonts, logo) edited in the admin with a live preview frame.
- Done when: Playwright test changes a color and sees it in preview.

### N26 · Page cache and SEO basics

- Depends on: N23
- Scope: full-page cache for anonymous visitors (memory and disk adapters) purged on publish; sitemap.xml, RSS, meta and Open Graph tags.
- Done when: tests cover cache hit/purge and sitemap output.

## Phase 4: Plugin system

### N27 · Plugin packages, discovery and migrations

- Depends on: N02
- Scope: `plugin.json` manifest (name, version, permissions, entry), discovery from a plugins directory, enabled state stored in DB, plugin-owned DB migrations.
- Done when: tests cover discovery, enable/disable persistence and migrations.

### N28 · Plugin management in the admin

- Depends on: N27, N21
- Scope: plugins screen (list, activate, deactivate, upload .zip, show declared permissions before activation).
- Done when: Playwright test uploads and activates a plugin.

### N29 · `nodepress` CLI and plugin scaffolder

- Depends on: N27
- Scope: `packages/cli` with `dev`, `migrate`, `plugin create`, `theme create`.
- Done when: CI scaffolds a plugin and builds it.

### N30 · SEO plugin

- Depends on: N28, N26
- Scope: per-post meta title/description, social image, robots settings, schema.org JSON-LD.
- Done when: tests cover output tags.

### N31 · Contact form plugin

- Depends on: N28
- Scope: form block, spam protection (honeypot and rate limit), submissions stored and emailed through a mail adapter.
- Done when: tests cover submission and spam rejection.

### N32 · Redirects plugin

- Depends on: N28
- Scope: manage 301/302 redirects in the admin, CSV import.
- Done when: tests cover matching and import.

## Phase 5: Install, deploy, migrate

### N33 · `create-nodepress` installer

- Depends on: N29, N23
- Scope: `npx create-nodepress my-site` asks site name, admin account and database, then produces a running site.
- Done when: CI runs the installer non-interactively and the smoke test passes.

### N34 · Web installer

- Depends on: N33
- Scope: first visit to a fresh install shows a setup wizard (database check, site name, admin account).
- Done when: Playwright test completes the wizard.

### N35 · Docker image and deploy templates

- Depends on: N33
- Scope: Dockerfile, docker-compose (with Postgres), templates for Railway, Render and Fly.io.
- Done when: CI builds the image and runs the smoke test inside it.

### N36 · WordPress importer

- Depends on: N12, N11, N08
- Scope: import a WordPress WXR file (posts, pages, categories, tags, authors, media, comments as meta), rewrite internal links, keep URLs with a redirect map.
- Done when: tests import a fixture WXR export and check content and redirects.

### N37 · Backup and export

- Depends on: N36
- Scope: export all content and settings as JSON plus a media zip; import it back.
- Done when: round-trip test passes.

### N38 · Built-in updater

- Depends on: N28
- Needs you: decide where updates come from (npm registry, GitHub releases or a NodePress update server), then delete this line.
- Scope: check for and apply core, plugin and theme updates from the admin.
- Done when: tests cover version check and update flow with a mock registry.

## Phase 6: Beta → 1.0

### N39 · Security hardening pass

- Depends on: N28, N11, N04
- Scope: CSP and security headers, upload checks review, dependency audit in CI, `SECURITY.md`, fix findings.
- Done when: findings fixed or listed as follow-up tasks.

### N40 · End-to-end test suite

- Depends on: N34
- Scope: Playwright suite for install → write → publish → plugin → theme flows, run in CI.
- Done when: suite green in CI.

### N41 · Performance budget

- Depends on: N26
- Scope: benchmark script; budget of < 100 ms TTFB cached and Lighthouse ≥ 95 on Aurora enforced in CI.
- Done when: budget check runs in CI.

### N42 · Documentation site

- Depends on: N29
- Scope: `apps/docs` with Starlight: getting started, plugin guide, theme guide, hooks reference generated from types.
- Done when: docs build in CI.

### N99 · Plan the next tasks

- Depends on: none
- Scope: only when fewer than 3 tasks above are ready to work on: read PLAN.md, propose the next 5–10 tasks and add them to this file in a PR.
- Done when: PR opened with the new tasks.
