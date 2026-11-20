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

### N49 · Plugin fields in the post sidebar

- Depends on: N21
- Scope: follow-up to N21, which delivered the admin extension registry (`context.admin`: `addPage`, `addMenuItem`, `addPostField`), `GET`/`PATCH /api/v1/admin-extensions`, the sidebar menu items and plugin settings pages, and made fields added with `addPostField` part of the content type (`content-type:fields` filter), so the content API already stores, validates and returns them in `meta`. Show them in the post edit sidebar: the edit screen reads the content type's `fields` from `/api/v1/content-types`, draws a "Custom fields" panel for every field that core does not already have a panel for (text, number, boolean, date, select; skip media, relation and rich text for now), saves them through `meta` with the rest of the post, and sends only the fields that changed. Add an example `subtitle` field to `plugins/hello-nodepress`.
- Done when: Playwright test fills in the example plugin's field on a post, saves, reloads and sees it; unit tests cover the draft/diff helpers.

## Phase 3: Themes & front end

### N22 · Theme loader and template hierarchy

- Depends on: N09
- Scope: `theme.json` manifest, theme discovery, TSX templates rendered on the server, template hierarchy (`single-{type}` → `single` → `index`), theme assets served with cache headers.
- Done when: tests cover hierarchy resolution and rendering.

### N23 · Default theme "Aurora"

- Depends on: N22
- Scope: blog and business layouts, responsive, accessible (WCAG 2.1 AA), dark mode; replaces the temporary front page.
- Done when: Lighthouse accessibility ≥ 95 in CI.

### N50 · Render post and page bodies on the front end

- Depends on: N23
- Scope: follow-up to N23. The server does not pass `renderBody` to the theme system yet, so Aurora (like the starter theme) shows a post's title and excerpt but not its body. Wire `themes.renderBody` in `apps/server/src/main.ts` to the block renderer in `@nodepress/editor` (`renderBlocks` with the core registry; add the workspace dependency to the server). The stored `ContentBlock` (`text`) and the editor `Block` (`content` text nodes) shapes differ: convert in one tested adapter and apply the `post:content` filter to the result. Skip unknown blocks without failing the page.
- Done when: a server test publishes a post with paragraph, heading and list blocks and sees the HTML at its permalink, and the CI smoke test checks it.

### N24 · Menus and widget areas

- Depends on: N22, N20
- Scope: menu builder API and admin screen, theme-declared menu locations and widget areas.
- Done when: tests and a Playwright test cover creating a menu.
- Delivered in slices: the menu service, API, theme locations and Aurora rendering (N24); the admin Menus screen and its Playwright test (N51); widget areas (N52).

### N51 · Menus screen in the admin

- Depends on: N24
- Scope: follow-up to N24, which delivered the menu service, `/api/v1/menus`, `/api/v1/menu-locations` (`edit_theme_options`), theme-declared menu locations (`menus` in `theme.json`) and Aurora's primary and footer menus. Add the admin "Menus" screen (sidebar entry shown with `edit_theme_options`): pick or create a menu, add, edit, remove and reorder links with nesting up to 3 levels (keyboard-operable move up/down/indent buttons, no drag-only controls), rename and delete a menu, and assign menus to the active theme's locations.
- Done when: a Playwright test creates a menu with a nested link, assigns it to a location and sees it on the front page; unit tests cover the tree-editing helpers.

### N52 · Widget areas

- Depends on: N24
- Scope: follow-up to N24, whose theme manifest already accepts `widgetAreas`. Widget service (areas declared by the active theme, ordered widgets per area stored in the options table, built-in `text` (plain text, escaped), `menu` and `recent-posts` widget types, `registerWidget()` for plugins), `GET`/`PUT /api/v1/widgets` (`edit_theme_options`), `widgets` prop for templates, a `sidebar` area in Aurora, and the admin "Widgets" screen.
- Done when: API tests cover validation and permission denial, a theme test shows a widget in the sidebar, and a Playwright test adds a text widget.
- Delivered in slices: the widget service, `/api/v1/widgets`, `context.registerWidget()`, the `widgets` template prop and Aurora's sidebar (N52); the admin Widgets screen and its Playwright test (N53).

### N53 · Widgets screen in the admin

- Depends on: N52
- Scope: follow-up to N52, which delivered the widget service (built-in `text`, `menu` and `recent-posts` types), `GET`/`PUT /api/v1/widgets` (`edit_theme_options`; the `GET` lists the theme's `areas`, the `widgets` in each and the available `types` with their `fields`), `context.registerWidget()` for plugins and Aurora's `sidebar` area. Add the admin "Widgets" screen (sidebar entry shown with `edit_theme_options`, hidden when the API answers 403): one section per area, a list of the area's widgets with a form per widget drawn from its type's `fields` (`text`, `textarea`, `number`, `menu` choices from `/api/v1/menus`), keyboard-operable Move up / Move down / Remove buttons (no drag-only controls), an "Add widget" type picker, and Save per screen through `PUT /api/v1/widgets`; unit tests for the list-editing helpers.
- Done when: a Playwright test adds a text widget to the sidebar and sees it on the front page; unit tests cover the helpers.

### N25 · Theme customizer with live preview

- Depends on: N23
- Scope: theme settings schema (colors, fonts, logo) edited in the admin with a live preview frame.
- Done when: Playwright test changes a color and sees it in preview.

### N26 · Page cache and SEO basics

- Depends on: N23
- Scope: full-page cache for anonymous visitors (memory and disk adapters) purged on publish; sitemap.xml, RSS, meta and Open Graph tags.
- Done when: tests cover cache hit/purge and sitemap output.
- Delivered in slices: the page cache, sitemap and RSS feed (N26); meta description and Open Graph tags (N54).

### N54 · Meta and Open Graph tags

- Depends on: N26
- Scope: follow-up to N26, which delivered the page cache, `/sitemap.xml` and `/feed.xml`. Give themes what they need for SEO tags: a `meta` template prop (`description` from the excerpt or tagline, canonical URL, `og:title`, `og:description`, `og:type` `article` or `website`, `og:url`, `og:site_name`, and `og:image` from a post's `featured_image` custom field when it has one) built in the server from the public site address (`SITE_URL`, else the request origin), a `meta:tags` filter so plugins (the SEO plugin, N30) can change it, and `<link rel="canonical">`, the description, Open Graph tags and an RSS `<link rel="alternate">` in Aurora's `<head>` (every value escaped; Aurora's Lighthouse accessibility score must stay at or above 95).
- Done when: server tests cover the `meta` prop (post, page, front page, 404) and the filter, an Aurora test checks the tags and their escaping, and the CI smoke test finds the canonical link on the front page.

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
- Delivered in slices: the service, spam protection, storage, mail adapter interface and API (N31); the form block, SMTP and the admin Messages screen (N56). Plugins cannot register routes or use the database yet, so the first slice lives in core and the server.

### N56 · Contact form block and SMTP mail

- Depends on: N31
- Scope: follow-up to N31, which delivered the contact form service in `@nodepress/core` (validation, honeypot, signed time token, per-sender rate limit, stored in `contact_submissions`, mail adapter interface with memory and log adapters) and `/api/v1/contact` (`GET /token`, `POST /`, `GET /submissions`). Add the `core/contact-form` block (editor block, renderer that draws a labelled, accessible `<form>` with the hidden `website` honeypot and the token, plus a small script-free fallback and a script that posts the JSON and shows the field errors), an SMTP mail adapter selected with `MAIL_URL` (needs npm access for `nodemailer`), and an admin "Messages" screen listing `GET /api/v1/contact/submissions`.
- Done when: renderer tests cover the form markup and escaping, the SMTP adapter is tested against a fake transport, and a Playwright test sends a message from a page and sees it in the admin.

### N32 · Redirects plugin

- Depends on: N28
- Scope: manage 301/302 redirects in the admin, CSV import.
- Done when: tests cover matching and import.
- Delivered in slices: the service, CSV import, API and front-end matching (N32); the admin screen (N57). Plugins cannot register routes yet, so the first slice lives in core and the server.

### N57 · Redirects screen in the admin

- Depends on: N32
- Scope: follow-up to N32, which delivered the redirects service in `@nodepress/core` (301/302, trailing `*` wildcard, loop protection, CSV import) and `/api/v1/redirects` (`GET`, `POST`, `PATCH /:id`, `DELETE /:id`, `POST /import` with a `text/csv` body; `manage_options`) plus the front-end matching. Add the admin "Redirects" screen (sidebar entry shown with `manage_options`, hidden on 403): a table of rules with add, edit and delete, field errors from the API shown next to the field, a CSV file picker that uploads to `/import` and lists the refused lines, and a link that downloads the current rules as CSV.
- Done when: a Playwright test adds a rule, imports a CSV and sees the redirect work on the front page; unit tests cover the CSV export helper.

### N59 · WordPress import: download media

- Depends on: N55
- Scope: follow-up to N55, whose import report lists the files in `attachments` but does not download them. Download each attachment into the media library (through the media service, so type and size checks and variants apply), with a guarded fetch (http(s) only, no private or loopback addresses, size and time limits, a few at a time; reuse the webhook host check), rewrite image URLs in imported blocks and the `_thumbnail_id` into the `featured_image` custom field, and report files that failed so the import can be repeated for them.
- Done when: tests with a fake fetcher cover success, blocked hosts, oversize files and the rewrite; the import report lists what was and was not downloaded.

### N60 · WordPress import screen in the admin

- Depends on: N55
- Scope: follow-up to N55, which delivered `POST /api/v1/import/wordpress` (WXR body up to 64 MB; authors matched by email, else the importing user or `default_author`; old URLs saved as 301 redirects; one import at a time). Add the admin "Import" screen (sidebar entry shown with `manage_options`): choose the `.xml` file, choose the default author and whether to match authors by email, run the import, and show the report (counts, skipped items, redirects saved or skipped, warnings).
- Done when: a Playwright test uploads the fixture export and sees the report; the imported post opens on the front page and its old URL redirects.

### N61 · Backup: menus, widgets and redirects, and the Backup screen

- Depends on: N37
- Scope: follow-up to N37, whose export is the JSON of content (every status), custom fields, terms and site settings, and whose import adds that next to existing content. Add menus (with their locations), widgets and redirect rules (validated by their services on import), and the admin "Backup" screen (download export, upload a file, show the summary). The media zip and theme settings are split off as N65.
- Done when: a round-trip test covers menus, widgets and redirects; a Playwright test downloads an export and imports it into a fresh site.

### N65 · Backup: media zip and theme settings

- Depends on: N61
- Scope: split from N61. Add what the JSON backup of N61 leaves out: a media zip (`GET /api/v1/backup/media`, the originals with a manifest of ids, alt text and MIME types; a strict reader on import that goes through the media service so type, size and variant rules apply, then rewrites `featured_image` and image blocks to the new ids) and the theme settings of the active theme (validated by the theme settings service). The Backup screen offers both.
- Done when: a round-trip test covers media (with a fake image processor) and theme settings; a Playwright test downloads the media zip and restores it into the empty site.

## Phase 5: Install, deploy, migrate

### N33 · `create-nodepress` installer

- Depends on: N29, N23
- Needs you: decide how NodePress is distributed (npm packages, a template repository or Docker first): see `docs/adr/0002-distribution.md`, fill in its `Decision:` line, then delete this line.
- Scope: `npx create-nodepress my-site` asks site name, admin account and database, then produces a running site.
- Done when: CI runs the installer non-interactively and the smoke test passes.
- First slice (done, PR for N33): `packages/create-nodepress` asks (or takes flags for) the site name, administrator, database, port and public address, writes `.env` (random secrets, mode 600), `package.json`, `README.md`, `.gitignore` and `plugins-installed/` into a new folder, and runs the server of a built checkout given with `--from`; CI creates a site that way and runs the smoke checks against it. The second slice (a real `npx` install) waits for the decision above.

### N34 · Web installer

- Depends on: N33
- Scope: first visit to a fresh install shows a setup wizard (database check, site name, admin account).
- Done when: Playwright test completes the wizard.

### N35 · Docker image and deploy templates

- Depends on: N33
- Scope: Dockerfile, docker-compose (with Postgres), templates for Railway, Render and Fly.io.
- Done when: CI builds the image and runs the smoke test inside it.

### N63 · Docker: publish and slim the image, one-click deploy buttons

- Depends on: N35
- Needs you: a GitHub Container Registry package (or Docker Hub account) for the image name, and accounts on Railway, Render and Fly.io to check the templates in `deploy/` on a real deploy.
- Scope: follow-up to N35, whose image is built from the repository and contains the whole build tree. Publish it to the registry on version tags (`ghcr.io/<owner>/nodepress`, multi-arch), shrink it (production dependencies only through `pnpm deploy`, no sources or caches), add a read-only root filesystem test, and add "Deploy" buttons and deploy guides once the templates are verified.
- Done when: a tag push publishes an image that CI pulls and smoke tests, and the image is under half its current size.

### N36 · WordPress importer

- Depends on: N12, N11, N08
- Scope: import a WordPress WXR file (posts, pages, categories, tags, authors, media, comments as meta), rewrite internal links, keep URLs with a redirect map.
- Done when: tests import a fixture WXR export and check content and redirects.

### N55 · WordPress import: endpoint, admin screen, media and redirects

- Depends on: N36
- Scope: finish N36's first slice. `POST /api/v1/import/wordpress` (admin only, size limit) that runs `importWordPress` and returns its report; an admin Import screen with author matching (by email, or choose a user); download the files listed in `attachments` into the media library and rewrite image URLs and `_thumbnail_id`; serve the redirect map (store old path → new path and answer 301 before the 404).
- Done when: an API test imports the fixture export, a Playwright test uploads it, and an old URL answers 301 to the new one.
- Delivered in slices: the endpoint, author matching and saving the redirect map as redirects (N55); media download (N59); the admin Import screen (N60).

### N37 · Backup and export

- Depends on: N36
- Scope: export all content and settings as JSON plus a media zip; import it back.
- Done when: round-trip test passes.
- Delivered in slices: JSON export and import of content, custom fields, terms and site settings with the API (N37); the media zip, menus, widgets, redirects and the admin screen (N61).

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
- Delivered in slices: security headers, `SECURITY.md`, the audit job and Dependabot, and a first review (N39); the second pass (N62).

### N62 · Security hardening, second pass

- Depends on: N39
- Scope: follow-up to N39 (headers, `SECURITY.md`, audit job, first review in `docs/security-review.md`). Review every API route's capability checks against the capability map, the admin app's output encoding, and the importers (WXR, zip, CSV, backup JSON) with hostile inputs; try to drop `style-src 'unsafe-inline'` for the admin and for Aurora (move the customizer CSS into a served stylesheet or use a nonce) and tighten the policy; make the audit job blocking once it is clean; fix what the review finds or list it as tasks.
- Done when: the review is extended in `docs/security-review.md`, tests cover each fix, and the audit job has no open high or critical findings.

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
