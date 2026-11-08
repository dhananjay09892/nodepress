# NodePress — Project Plan

> **WordPress's ease and plugin ecosystem, on a modern JavaScript stack.**

Status: Draft v0.1 · Owner: Dhananjay Patel · Last updated: 2026-11-08

---

## 1. Vision

NodePress is an open-source, self-hostable CMS written in TypeScript. A non-developer can install it in one click, pick a theme, add plugins from the admin panel, and have a working website. A developer can extend every part of it through hooks, use it headless through an API, or deploy it to serverless/edge.

### Why it should exist

| Product    | What it does well                    | What it leaves out                          |
| ---------- | ------------------------------------ | ------------------------------------------- |
| WordPress  | Ease of use, themes, 60k+ plugins    | Legacy PHP, slow by default, security debt  |
| Ghost      | Beautiful publishing                 | No general plugin system, blog-only         |
| Strapi     | Headless content API                 | No themes/front end; developers required    |
| Payload    | Developer experience, Next.js native | Developer-only; no theme/plugin marketplace |
| KeystoneJS | GraphQL data framework               | Small ecosystem, developer-only             |

**NodePress fills the gap:** full website + themes + installable plugins (like WordPress), with headless as an _option_, built on modern JS.

### Target users (in order of priority)

1. **Bloggers & small businesses.** They want a site, not a codebase. (Primary for v1.0.)
2. **Freelancers & agencies.** They build client sites and want a modern stack clients can edit.
3. **JS developers.** They want a CMS they can extend in the language they already use.

### Product principles

1. **Zero-code path always works.** Anything a developer can do through code, a site owner should be able to do in the admin, or through a plugin that adds it.
2. **Fast by default.** Server-rendered HTML, minimal JS shipped to visitors, built-in caching.
3. **Hooks everywhere.** If core does it, a plugin can change it.
4. **Secure by default.** Safe defaults, automatic updates for security fixes, no plain-text secrets.
5. **Your data, portable.** Export everything; import from WordPress.

---

## 2. Tech stack (proposed)

| Concern     | Choice                                                                      | Why                                                     |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| Language    | TypeScript (strict)                                                         | Safety for core and a typed API for plugin authors      |
| Runtime     | Node.js 22 LTS+ (Bun/Deno compatible where possible)                        | Largest hosting support                                 |
| Monorepo    | pnpm workspaces + Turborepo                                                 | Fast installs, cached builds                            |
| HTTP server | Hono                                                                        | Tiny, fast, runs on Node, Bun, Cloudflare, Vercel       |
| Database    | Drizzle ORM: SQLite (default), PostgreSQL, MySQL                            | SQLite = zero-config installs; Postgres/MySQL for scale |
| Validation  | Zod                                                                         | Shared schemas for API, admin forms, and plugins        |
| Admin UI    | React + Vite + TanStack Router/Query + Tailwind                             | Large hiring/contributor pool                           |
| Editor      | Block editor on Lexical (or Tiptap; decide in Phase 2 spike)                | Gutenberg-style blocks, JSON storage                    |
| Themes      | TSX components rendered on the server; optional "islands" for interactivity | Simple HTML output, familiar to JS devs                 |
| Auth        | Session cookies (+ API tokens), Argon2 password hashing                     | Proven, simple                                          |
| Media       | `sharp` for resizing; local disk or S3-compatible storage                   | Standard and fast                                       |
| Jobs/Cron   | Built-in job queue on DB table (pluggable: BullMQ/Redis)                    | No extra infra for small sites                          |
| Testing     | Vitest (unit), Playwright (end-to-end)                                      | Fast and modern                                         |
| Docs        | Starlight (Astro)                                                           | Good docs sites with little effort                      |

---

## 3. Repository structure

```
nodepress/
├── apps/
│   ├── server/            # Runs a NodePress site (boots core, loads theme + plugins)
│   ├── admin/             # React admin dashboard (built and served by server at /admin)
│   └── docs/              # Documentation site
├── packages/
│   ├── core/              # Kernel: hooks, content API, auth, settings, plugin/theme loaders
│   ├── db/                # Drizzle schema, migrations, adapters
│   ├── editor/            # Block editor + block registry
│   ├── sdk/               # Public types & helpers for plugin/theme authors (@nodepress/sdk)
│   ├── cli/               # `nodepress` CLI (dev, build, migrate, plugin scaffolding)
│   └── create-nodepress/  # `npx create-nodepress` installer
├── themes/
│   └── aurora/            # Default theme
├── plugins/
│   ├── seo/               # Example first-party plugins
│   ├── contact-form/
│   └── hello-nodepress/   # Minimal example plugin
├── PLAN.md
└── README.md
```

---

## 4. Core architecture

### 4.1 Request lifecycle

```
Request
  → middleware (security headers, session, rate limit)
  → hook: `request:start`
  → router
       /admin/*      → admin SPA
       /api/*        → REST API (filters: `api:response`)
       /*            → front-end resolver
                         → find content by permalink
                         → hook: `template:resolve` (pick theme template)
                         → render TSX → filter: `render:html`
  → cache layer (page cache for anonymous visitors)
  → hook: `request:end`
Response
```

### 4.2 Hook system (the heart of NodePress)

Two kinds of hooks, mirroring WordPress but async and typed:

- **Actions:** "something happened". Listeners run side effects.
- **Filters:** "here's a value". Each listener can change it and pass it on.

```ts
import { definePlugin } from '@nodepress/sdk';

export default definePlugin({
  name: 'reading-time',
  setup({ hooks }) {
    hooks.addFilter(
      'post:content',
      async (html, { post }) => {
        const minutes = Math.ceil(post.wordCount / 200);
        return `<p class="reading-time">${minutes} min read</p>` + html;
      },
      { priority: 10 },
    );

    hooks.addAction('post:published', async (post) => {
      // e.g. ping a webhook
    });
  },
});
```

Requirements:

- Priorities (lower runs first), and listeners can be removed.
- Typed hook names and payloads, so plugin authors get autocomplete.
- Errors in one listener are caught and logged; they don't crash the site.
- Timing instrumentation (find slow plugins).

### 4.3 Content model

- **Content types:** `post` and `page` built in. Plugins/admin can register **custom content types** (e.g. `product`, `event`) with custom fields.
- **Fields:** text, rich text (blocks), number, boolean, date, select, media, relation, repeater/group.
- **Taxonomies:** categories, tags, plus custom taxonomies.
- **Revisions & drafts:** every save creates a revision; scheduled publishing.
- **Permalinks:** configurable patterns (`/blog/:slug`, `/:year/:month/:slug`).
- **i18n-ready:** core strings translatable; content localization as a v1.x feature.

### 4.4 Database schema (first pass)

| Table                      | Key columns                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `users`                    | id, email, password_hash, display_name, role, created_at                                                   |
| `sessions` / `api_tokens`  | id, user_id, token_hash, expires_at                                                                        |
| `content`                  | id, type, status, title, slug, body (JSON blocks), excerpt, author_id, parent_id, published_at, updated_at |
| `content_meta`             | content_id, key, value (JSON)                                                                              |
| `revisions`                | id, content_id, snapshot (JSON), author_id, created_at                                                     |
| `terms` / `term_relations` | taxonomy, name, slug, parent_id / content_id, term_id                                                      |
| `media`                    | id, path, mime, size, width, height, alt, variants (JSON)                                                  |
| `options`                  | key, value (JSON), autoload                                                                                |
| `plugins`                  | name, version, enabled, settings (JSON)                                                                    |
| `jobs`                     | id, type, payload, run_at, attempts, status                                                                |

### 4.5 Users, roles, capabilities

- Roles: Administrator, Editor, Author, Contributor, Subscriber.
- Permission checks use **capabilities** (`edit_posts`, `manage_plugins`), not roles directly. Plugins can add capabilities.
- Later: 2FA (TOTP), passkeys, OAuth login via plugin.

### 4.6 Themes

- A theme is an npm-style package: `theme.json` (name, version, supported features, settings schema) + TSX templates (`index`, `single`, `page`, `archive`, `404`) + assets.
- **Template hierarchy** like WordPress: `single-product.tsx` → `single.tsx` → `index.tsx`.
- Theme settings (colors, fonts, logo) are editable in the admin through a **live-preview customizer**.
- Child themes: override individual templates.

### 4.7 Plugins

- A plugin is a package with a `plugin.json` manifest + entry file exporting `definePlugin(...)`.
- Plugins can: use hooks, register content types/fields/blocks, add admin pages and settings screens, add API routes, schedule jobs, and run database migrations.
- Lifecycle: `install → activate → deactivate → uninstall`, each with hooks.
- **Security model (v1):** plugins run in-process (like WordPress), so they're trusted code. We get safety from a reviewed marketplace, signed packages, and a declared permissions list in the manifest shown before install. (Future: sandboxed plugins via isolates/WASM.)

### 4.8 APIs

- **REST API** at `/api/v1` for all content types, generated automatically from the content model, with filtering, pagination, and field selection.
- **Webhooks** on content events.
- **GraphQL**: an official plugin, not core.
- **Typed client SDK** for headless front ends (Next.js, Astro, SvelteKit).

### 4.9 Performance & caching

- Full-page cache for anonymous visitors (memory/disk/Redis adapters), auto-purged on publish.
- Image variants generated on upload; responsive `srcset` by default.
- **Static export mode:** `nodepress build --static` outputs a fully static site.

### 4.10 Installer & deployment

- `npx create-nodepress my-site` → asks for site name, admin account, DB (SQLite default) → running site.
- Web installer on first visit (like WordPress's 5-minute install) for hosting without terminal access.
- One-click deploy templates: Docker, Railway, Render, Fly.io, DigitalOcean, Vercel/Cloudflare (edge mode with Postgres/D1).
- Built-in updater: core/plugin/theme updates from the admin.

### 4.11 WordPress importer (key adoption feature)

- Import WordPress WXR export files: posts, pages, categories, tags, authors, media, comments.
- Rewrite internal links and keep URLs the same (redirect map) to protect SEO.

---

## 5. Roadmap

Timeline assumes 1–2 developers part-time; adjust as the team grows.

### Phase 0: Foundations (weeks 1–2)

- [x] Monorepo setup (pnpm, Turborepo, TypeScript, ESLint/Prettier, Vitest)
- [x] CI on GitHub Actions (lint, typecheck, test)
- [x] Decide license → MIT
- [x] `packages/core`: kernel boot + hook system with full tests
- [~] `packages/db`: Drizzle schema v1 (SQLite done; Postgres variant + committed migrations pending)

**Exit:** `pnpm dev` boots a server that runs hooks and connects to a DB.

### Phase 1: Content core & API (weeks 3–6)

- [ ] Content CRUD service, revisions, drafts, scheduling
- [ ] Taxonomies, permalinks, options/settings
- [ ] Users, sessions, roles/capabilities
- [ ] Media upload + image variants
- [ ] REST API v1 + API tokens
- [ ] Job queue + scheduled publishing

**Exit:** create/publish content through the API, with tests >80% on core.

### Phase 2: Admin dashboard (weeks 7–11)

- [ ] Admin shell: login, navigation, dashboard
- [ ] Editor spike: Lexical vs Tiptap → pick one
- [ ] Block editor with core blocks (paragraph, heading, image, list, quote, code, embed, columns, button)
- [ ] Posts/pages lists, filters, bulk actions
- [ ] Media library, users, settings screens
- [ ] Admin extension points (plugins add menus, pages, fields)

**Exit:** a non-developer can write and publish a post entirely in the admin.

### Phase 3: Themes & front end (weeks 12–14)

- [ ] Theme loader + template hierarchy
- [ ] Default theme **Aurora** (blog + business layouts, responsive, accessible)
- [ ] Menus & widgets/sidebar areas
- [ ] Customizer with live preview
- [ ] Page cache + SEO basics (meta, sitemap, RSS, Open Graph)

**Exit:** a fresh install shows a polished, fast website.

### Phase 4: Plugin system (weeks 15–18)

- [ ] Plugin manifest, loader, lifecycle, plugin migrations
- [ ] Install/activate/deactivate from admin (upload .zip or from registry)
- [ ] `nodepress plugin create` scaffolder
- [ ] First-party plugins: SEO, Contact Form, Redirects, Analytics (privacy-friendly)
- [ ] Plugin author docs + example repo

**Exit:** a third-party developer can build and install a plugin in under an hour using the docs.

### Phase 5: Install, deploy, migrate (weeks 19–21)

- [ ] `create-nodepress` CLI + web installer
- [ ] Docker image + one-click deploy templates
- [ ] Built-in updater
- [ ] WordPress importer
- [ ] Backup/export (JSON + media zip)

### Phase 6: Beta → 1.0 (weeks 22–26)

- [ ] Private beta with 10–20 real sites (bloggers, small businesses, 2–3 agencies)
- [ ] Security review (auth, uploads, XSS/CSRF/SQLi, plugin permissions)
- [ ] Performance budget: <100 ms TTFB cached, Lighthouse 95+ on default theme
- [ ] Accessibility audit of admin + default theme (WCAG 2.1 AA)
- [ ] Docs site, landing page, launch posts
- [ ] **v1.0 public release**

### After 1.0

- Theme & plugin **marketplace** (with review + signing)
- Comments, memberships, newsletters (plugins)
- Multilingual content
- E-commerce plugin
- Multisite
- AI features: writing assistant, alt text, translation, MCP server for agent access
- **NodePress Cloud** (managed hosting)

---

## 6. Quality, security & operations

- **Testing:** unit tests for core services; integration tests against SQLite + Postgres; Playwright end-to-end for admin flows.
- **Security:** CSRF tokens, strict CSP, parameterized queries only (Drizzle), upload type/size checks, rate-limited login, security headers, dependency scanning (Dependabot/Socket), responsible disclosure policy (`SECURITY.md`).
- **Versioning:** semver; public hook names and SDK types are part of the API, so breaking changes only in major versions.
- **Releases:** Changesets for versioning and changelogs; npm publishing from CI.
- **Telemetry:** none by default; optional, anonymous, opt-in.

---

## 7. Business model (optional, decide later)

- Free and open-source core forever.
- **NodePress Cloud:** managed hosting (main revenue path, like WordPress.com / Ghost(Pro)).
- **Marketplace:** revenue share on premium themes/plugins.
- Paid support / agency partner program.

---

## 8. Open decisions

| #   | Decision            | Options                                         | Notes                                             |
| --- | ------------------- | ----------------------------------------------- | ------------------------------------------------- |
| 1   | License             | ✅ **MIT** (decided 2026-11-08)                 | Maximum adoption for plugins, themes and agencies |
| 2   | Editor engine       | Lexical · Tiptap                                | Decide after Phase 2 spike                        |
| 3   | Theme rendering     | Server React (TSX) · Hono JSX · template engine | Proposal: server TSX for familiarity              |
| 4   | Name/trademark      | NodePress                                       | Check npm, domains, GitHub org, trademark         |
| 5   | Primary v1 audience | Bloggers/SMBs (proposed) · agencies             | Shapes default theme & first plugins              |

---

## 9. Risks

| Risk                                              | Mitigation                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Scope is huge (WordPress took 20 years)           | Strict phase exit criteria; ship v1 to one audience                          |
| Ecosystem chicken-and-egg (no plugins → no users) | First-party plugins for top needs; WordPress importer; excellent plugin docs |
| In-process plugins = security risk                | Reviewed marketplace, signing, permission manifests, future sandboxing       |
| Competitors move into this space                  | Move fast on the non-developer experience, which they aren't focused on      |
| Maintainer burnout                                | Small, clear roadmap; invite contributors early with good-first-issues       |

---

## 10. Immediate next steps

1. Create the private GitHub repo and push this scaffold.
2. Make decisions #1 (license) and #5 (audience).
3. Start Phase 0: monorepo setup + hook system with tests.
4. Reserve name: npm `nodepress` / `@nodepress` scope, domain, GitHub org.
