# ADR 0004: Where the built-in updater gets updates

- Status: Proposed (waiting for the owner)
- Date: 2026-11-27
- Related: PLAN.md ("Built-in updater", secure-by-default principle); queue tasks N38 (updater), N35 (Docker image), N28 (plugins screen); ADR 0002 (distribution), ADR 0003 (plugin registry)

Decision:

<!-- Owner: write the chosen option (A, B, C or another) on the line above, then remove the "Needs you" line from N38 in docs/QUEUE.md and check that its scope still matches. -->

## Context

N38 promises "check for and apply core, plugin and theme updates from the admin". Three different things can be updated, and they behave differently:

- **Core** is the server, the admin build, the built-in themes and plugins, and database migrations. It runs in one process: replacing files means restarting, and a failed update can leave the site down.
- **Plugins and themes** are folders (ADR 0003 covers how plugins are discovered and fetched). They can be replaced while the site runs, but a plugin may own database tables with its own migrations.
- **Docker installs** (N35) are already immutable: the image _is_ the version, the filesystem may be read-only, and the update is "pull a new image and restart". An in-admin "apply update" button cannot and should not write into the container.

Whatever the source, an update is downloaded code that then runs with the site's database access, so the update source is a security boundary. The updater must therefore at least verify integrity, never apply anything unattended without the owner's choice, and keep a way back.

Facts about the code today: migrations run at server start (`database.migrate()`), migrations are forward-only (there is no down step), and the server version is `0.0.0` (a release process does not exist yet; ADR 0002 decides how releases are published).

## What every option must handle

| Concern                  | Requirement                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrity                | The SHA-256 of what is downloaded must match a value obtained separately from the file (index, release notes, signed manifest).                                                                   |
| Authenticity             | Ideally a signature by a maintainer key shipped with NodePress, so a hacked host or CDN cannot push code to every site.                                                                           |
| Rollback                 | Keep the previous version on disk, take a database copy (SQLite) or require a backup confirmation (PostgreSQL) before migrating, and start the old version if the new one fails its health check. |
| Migrations               | Applied once, in order, at the first start of the new version. A failed migration stops the start and leaves the old files in place. Down-migrations are not promised.                            |
| Docker                   | Show "update available" with the exact image tag to pull; never write into the image.                                                                                                             |
| Offline or private sites | A check that cannot reach the source must fail quietly (a notice, not an error) and the site must keep working. A manual "upload an update package" path should exist.                            |
| Privacy                  | The check sends no site identifier. At most the current version in a request, or nothing at all (the client compares against a fetched list).                                                     |
| Major versions           | Never applied automatically; the notice links to release notes.                                                                                                                                   |

## Options

### Option A: npm registry

Core, plugins and themes are published as npm packages (this follows ADR 0002 option A). The updater asks the npm registry for the newest version of `@nodepress/*` packages and runs the package manager.

- Integrity and signing: npm records integrity hashes and registry signatures, and provenance attestations are available. Verifying them from inside the server means shelling out to `npm`/`pnpm`.
- Rollback: the package manager can reinstall the previous version, but a half-applied install of a dependency tree in a running process is the weakest rollback story of the three. A lockfile per site is needed to make installs repeatable.
- Migrations: run at the next start, as today.
- Docker: does not apply (the image is immutable); the check can still say "a new version exists".
- Offline: needs a mirror registry.
- Risk and effort: running `npm install` from the CMS process executes install scripts of the whole dependency tree with the site's privileges and needs write access to `node_modules` and a network path to the registry, which many hosts do not give. Highest security risk, lowest custom code.

### Option B: GitHub releases with checksums

Each release publishes a package (`nodepress-<version>.tar.gz` with the built server, admin, themes and built-in plugins), a `SHA256SUMS` file and a detached signature. The updater reads the releases feed (a small `latest.json` kept in the release assets avoids API rate limits), downloads the archive into a staging folder, verifies the checksum and signature, unpacks with the strict reader used for plugin uploads, swaps the folder (keeping the previous one), runs migrations and checks health.

- Integrity and signing: SHA-256 plus a maintainer signature, both checked by NodePress itself with `node:crypto`; no package manager involved.
- Rollback: the swap keeps `previous/`; an automatic revert on a failed health check is possible because the old folder is intact. Database copy for SQLite, backup prompt for PostgreSQL.
- Migrations: as above, at first start.
- Docker: the same `latest.json` drives the "update available" notice with an image tag; the apply button is hidden when the filesystem is read-only or `NODEPRESS_IMMUTABLE=1`.
- Offline: upload the archive manually (same verification); or mirror the release files.
- Plugins and themes: the registry index of ADR 0003 option A already holds URLs and checksums, so plugin and theme updates reuse it and the same verification code.
- Risk and effort: medium (staging, swap, revert and a restart mechanism that works under systemd, Docker and plain `node`). Hosting cost is zero. Depends on the release process of ADR 0002.

### Option C: A NodePress update server

A small service answers "what is the newest version for this channel" with signed manifests, can stage rollouts, withdraw a bad release and show security notices.

- Integrity and signing: strongest (signed manifests, server-side revocation).
- Rollback: same client-side mechanics as B; the server adds the ability to pull a broken release for everyone.
- Privacy: the server sees every check (IP, version) unless the design avoids it.
- Offline: needs a mirror story.
- Risk and effort: a hosted service to run and secure, and every site depends on it. Not justified before there are users; the features it adds over B (revocation, staged rollouts) can be approximated by editing `latest.json`.

## Trade-off summary

|                                 | A: npm                    | B: GitHub releases            | C: update server           |
| ------------------------------- | ------------------------- | ----------------------------- | -------------------------- |
| Checksum and signature          | npm's, checked via CLI    | ours, checked in-process      | ours, plus revocation      |
| Install scripts run on the host | yes                       | no (pre-built archive)        | no                         |
| Rollback                        | weak                      | keep previous folder          | same as B, plus withdrawal |
| Docker                          | notice only               | notice only (tag in manifest) | notice only                |
| Offline sites                   | mirror needed             | manual upload                 | mirror needed              |
| Hosting cost                    | none                      | none                          | real                       |
| Phone-home                      | registry sees the request | GitHub sees the request       | NodePress sees the request |
| Build effort                    | small                     | medium                        | large                      |

## Recommendation

Option B, scoped in two steps.

1. **Check only** (low risk, useful at once): a daily check of `latest.json` from the project's GitHub releases, shown as a notice on the dashboard for users with `manage_options`. No identifier is sent; `UPDATE_CHECK=off` disables it; a failed check is silent. Plugin and theme updates come from the registry index of ADR 0003 (if option A there is chosen), compared with the installed versions.
2. **Apply** for plugins and themes first (they are folders and the strict unpacker, checksum check and "stay off until enabled for new plugins" rules already exist), then for core on non-Docker installs with a staged folder swap, a pre-update database copy, migrations at the next start and automatic revert if the health check fails. Core updates that include a major version or a destructive migration stay manual.

Sign releases from the first one, and ship the public key with NodePress, so verification does not have to be added later. Docker users get the notice and the tag to pull, nothing else.

This keeps updates verified by NodePress itself (no package manager running with the site's privileges), costs nothing to host, works behind firewalls through manual upload, and does not need a service that must stay online. If the ecosystem grows, option C can be added in front of the same `latest.json` format.

## What this changes in the queue

If B is chosen, N38 can be built in the two steps above (the check and plugin/theme apply first; core apply as a follow-up). It depends on how releases are published (ADR 0002) and on the plugin registry format (ADR 0003, task N77); if those are undecided, build only the check. If A or C is chosen, N38's scope needs rewriting first.

## Open questions for the owner

- Who holds the release signing key, and how is it rotated or revoked?
- Is an automatic security-fix channel wanted (applied without a click), or is every update manual?
- Should the dashboard notice be on by default, given it contacts GitHub?
- Are PostgreSQL backups the owner's job before an update, or should NodePress refuse to apply core updates without a confirmation that a backup exists?
