# Documentation site

`apps/docs` (`@nodepress/docs`, private) is a Starlight (Astro) site with a getting-started guide, a plugin guide, a theme guide and a hooks reference. `pnpm build` builds it with the rest of the workspace, so a broken page fails CI; `pnpm --filter @nodepress/docs dev` serves it locally.

The hooks reference is generated, not written: `scripts/generate-hooks.ts` reads every `ActionMap` and `FilterMap` declaration in `packages/`, `plugins/` and `apps/server/` (test files excluded), keeps each hook's type and JSDoc comment, and writes `src/content/docs/reference/hooks.md` before every build. That file is git-ignored. To document a hook, put a JSDoc comment above its entry in the declaration.

The Docker image leaves the docs out (`--filter '!@nodepress/docs'`). Hosting the built site (`apps/docs/dist`) is not set up yet.

Astro and Starlight are `devDependencies`: the site is built, never run in production, so the production dependency audit does not cover them.
