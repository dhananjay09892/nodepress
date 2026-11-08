# NodePress: notes for Claude

NodePress is a WordPress-style CMS in TypeScript. Read `PLAN.md` for the product and architecture, and `docs/QUEUE.md` for the build queue.

## Conventions

- pnpm workspace + Turborepo. Packages in `packages/`, apps in `apps/`, example plugins in `plugins/`, themes in `themes/`.
- TypeScript strict (see `tsconfig.base.json`), ESM only, `.js` extensions in relative imports.
- Tests use Vitest (`*.test.ts` next to the code). Every change ships with tests.
- Public hook names and `@nodepress/sdk` types are public API: add, don't break.
- New hook names are declared in `ActionMap` / `FilterMap` via declaration merging so they are typed.
- A failing plugin must never take the site down; keep error isolation in hooks and plugin activation.
- Security: parameterized queries only (Drizzle), hash secrets/tokens at rest, no secrets or `.env` in git.

## Commands

```bash
pnpm install
pnpm build        # turbo build
pnpm test         # vitest
pnpm typecheck
pnpm lint
pnpm format
```

## When npm is unreachable (Claude sessions)

- Core logic with no dependencies can be tested with `bun test` (understands Vitest imports) and type-checked with the global `tsc` using `--typeRoots /opt/npm-tools/node_modules/@types`.
- After changing any `package.json`, push the branch and run the **Refresh lockfile and formatting** workflow on it:
  `gh api -X POST repos/dhananjay09892/nodepress/actions/workflows/refresh-lockfile.yml/dispatches -f ref=BRANCH`
  then `git pull` its commit. Rely on the PR's CI for lint, types, tests and the server smoke test.
- `gh pr ...` does not work here (GraphQL blocked); use `gh api` REST endpoints.
