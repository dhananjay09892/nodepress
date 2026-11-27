# Landing page

The home page of the docs site (`apps/docs/src/content/docs/index.mdx`, a Starlight splash page) says what NodePress is, why it exists, a three-step quick start, six feature highlights and links to the getting started guide, the plugin guide, the theme guide and GitHub. Highlights only name what exists today (taken from `PLAN.md`); the quick start uses `pnpm install` from a checkout until the distribution decision (ADR 0002) is made.

It is plain static HTML from the Starlight build: no tracking, no analytics, no external fonts or scripts. The CI job "Aurora accessibility (Lighthouse >= 95)" also serves `apps/docs/dist` and fails when this page scores under 95 for accessibility.

What the owner must provide before a public launch (domain, hosting, announcement text, screenshots): `docs/launch-checklist.md`.
