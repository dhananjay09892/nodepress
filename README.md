# NodePress

**WordPress's ease and plugin ecosystem, on a modern JavaScript stack.**

NodePress is an open-source CMS written in TypeScript. Install it in one click, pick a theme, add plugins from the admin panel — or extend everything with hooks and use it headless.

> ⚠️ Early development. See [PLAN.md](./PLAN.md) for the full plan and roadmap.

## Getting started (development)

Requirements: Node.js 22+, pnpm 9+.

```bash
pnpm install
pnpm --filter @nodepress/db db:generate   # first time only: create DB migrations
pnpm build
pnpm dev                                  # http://localhost:3000
```

- `GET /` — temporary front page (shows plugin filters in action)
- `GET /api/health` — kernel, database and plugin status

Other commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`.

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | Kernel: typed hook system (actions & filters), plugin manager, lifecycle |
| `packages/sdk` | Public API for plugin and theme authors (`definePlugin`, types) |
| `packages/db` | Drizzle schema v1 (SQLite/libSQL) and database client |
| `apps/server` | Hono HTTP server that boots a NodePress site |
| `plugins/hello-nodepress` | Minimal example plugin — copy it to start your own |

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

- [ ] Phase 0 — Foundations *(in progress)*
- [ ] Phase 1 — Content core & API
- [ ] Phase 2 — Admin dashboard
- [ ] Phase 3 — Themes & front end
- [ ] Phase 4 — Plugin system
- [ ] Phase 5 — Install, deploy, migrate
- [ ] Phase 6 — Beta → 1.0

## License

[MIT](./LICENSE)
