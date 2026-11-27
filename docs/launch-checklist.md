# Launch checklist

What the landing page (`apps/docs/src/content/docs/index.mdx`) and a public launch need from the owner. Nothing here can be done by the daily builder.

## Needed before the site can go public

- [ ] **A domain** for the docs and landing page, and DNS for it. Then set `site` in `apps/docs/astro.config.mjs` (it also turns on the sitemap).
- [ ] **A place to host `apps/docs/dist`** (GitHub Pages, Cloudflare Pages or similar) and the choice of how it deploys (a workflow on `main`, or the host's own build). This is not set up yet (see `docs/features/docs-site.md`).
- [ ] **A name check**: confirm "NodePress" is free to use (npm scope `@nodepress`, GitHub organization, domain, trademark search) before announcing it.

## Content the owner writes or supplies

- [ ] **Announcement text** (a post for the blog, Hacker News, Reddit, X and so on). The builder does not write launch posts.
- [ ] **Screenshots** of the admin (dashboard, post editor, media library) and of Aurora (blog and business layouts, light and dark), at 2x, with no private data. Add them to the landing page when they exist.
- [ ] **A short demo**: a screen recording of "install, write, publish" (under a minute).
- [ ] **A social preview image** (1280 x 640) for the repository.
- [ ] **A contact address** for security reports (see `SECURITY.md`) and for general questions.

## Decisions that change what the page can promise

- [ ] ADR 0002 (how NodePress is distributed): until it is decided there is no `npx create-nodepress` for end users, so the quick start on the landing page uses `pnpm install` from a checkout. Update step 1 when the decision is made.
- [ ] ADR 0003 (plugin registry): the page does not promise a plugin marketplace. Add it when a registry exists.
- [ ] ADR 0004 (updater): the page does not mention one-click updates.

## Checks before announcing

- [ ] The landing page passes the Lighthouse accessibility check in CI (the job audits it, 95 or higher).
- [ ] The quick start works on a clean machine, following only the page.
- [ ] Links all work (docs, GitHub, plugin and theme guides).
- [ ] No tracking or third-party scripts were added (the page loads no external fonts or analytics).
