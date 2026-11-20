# ADR 0002: How NodePress is distributed

- Status: Proposed (waiting for the owner)
- Date: 2026-11-20
- Related: PLAN.md sections on install and deploy; queue tasks N33, N34, N35, N38

Decision:

<!-- Owner: write the chosen option (A, B, C or another) on the line above, then remove the "Needs you" line from N33 in docs/QUEUE.md. -->

## Context

`create-nodepress` (N33) is meant to produce "a running site" from one command. Today nothing NodePress ships is published: `@nodepress/server` is `private`, the admin and themes are built in place by `pnpm build`, and the server finds the admin and the default themes next to itself (`../../admin/dist`, `../../../themes`). A site therefore cannot be created by installing packages. The first slice of N33 (`packages/create-nodepress`) works around this: it writes a site folder (`.env`, `package.json`, `plugins-installed/`) whose `start` script runs the server of a built NodePress checkout you point it at with `--from`. That is useful for development and for CI, but it is not what a first-time visitor expects from `npx create-nodepress my-site`.

The choice also decides how updates work (N38), what the Docker image contains (N35) and who can build themes and plugins without cloning the whole repository.

## Options

### Option A: Publish `@nodepress/*` packages to npm

Publish `@nodepress/core`, `db`, `sdk`, `editor`, `server`, the admin build and the default theme. `@nodepress/server` gets a `nodepress` bin (`nodepress start`) that locates the admin build and the themes inside `node_modules`. `create-nodepress` writes a `package.json` that depends on `@nodepress/server` and runs `npm install`.

- Pros: the familiar WordPress-on-Node path (`npx create-nodepress`, then `npm update`); plugin and theme authors depend on `@nodepress/sdk` from npm; updates are `npm update` or the future admin updater against the registry.
- Cons: needs a release process (versioning, provenance, a changelog), the owner's npm organization and 2FA, and care that the server package ships its built admin (large) and assets; every breaking change in a public type is a semver event.

### Option B: A template repository you clone

`create-nodepress` clones (or downloads a tarball of) a tagged release of the NodePress repository, installs with pnpm and builds. The site is the monorepo.

- Pros: no publishing; works today; people can read and patch everything.
- Cons: slow first run (install and build of the whole monorepo), large disk use, updates mean merging upstream, and plugin and theme authors have no small dependency to build against. Hard to run on shared hosting.

### Option C: Docker image first

Ship a container image (N35) as the main way to run NodePress; the installer only writes a `docker-compose.yml` and `.env`.

- Pros: one artifact with admin, themes and server inside; reproducible; easy on Railway, Render and Fly.io.
- Cons: not everyone has Docker; local development of plugins still needs the repository or packages; the image still has to be built from somewhere (it can be built from the repository in CI, so this does not remove the need for A or B for authors).

## Recommendation

Option A, with Option C built on top of it. Publish the packages (starting with a `0.x` series), give `@nodepress/server` a `nodepress start` bin, and let `create-nodepress` write a normal npm project. The Docker image (N35) then simply installs the same published packages. Keep `--from` as the development option of the installer.

Before the first release: choose the npm scope, decide the versioning policy for the public hook names and `@nodepress/sdk` types (CLAUDE.md already says "add, don't break"), and add a release workflow with npm provenance.

## What this changes in the queue

If A is chosen, add a task "Publish packages and `nodepress start`" before N33's second slice (N58 below); N35 builds the image from the published packages; N38 (updater) checks the npm registry.
