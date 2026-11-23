# ADR 0003: How plugins are installed from a registry

- Status: Proposed (waiting for the owner)
- Date: 2026-11-23
- Related: PLAN.md section 4.7 (plugins, security model); queue tasks N28 (plugins screen), N29 (CLI), N38 (updater), N74 and its follow-up "Install plugins from a registry"; ADR 0002 (distribution)

Decision:

<!-- Owner: write the chosen option (A, B, C, D or another) on the line above, then remove the "Needs you" line from the follow-up task "Install plugins from a registry" in docs/QUEUE.md. -->

## Context

Today a plugin reaches a site in one way: an administrator uploads a `.zip` on the Plugins screen (N28), or a folder is placed in `plugins-installed/`. The server unpacks uploads with a strict reader, checks `plugin.json`, shows the declared `permissions` before the plugin is enabled, and leaves a new package off until the owner turns it on. Plugins run in-process, so they are trusted code (PLAN.md 4.7); permissions are a declaration for the owner to review, not a sandbox (only `database` is enforced).

PLAN.md promises "install from registry". What is missing is a place to discover plugins, a way to fetch one by name and version, and a reason to trust what was fetched. Because a plugin is arbitrary code with the site's database access, the registry question is mostly a trust question.

What the install flow must carry, whatever the source:

- the `plugin.json` fields the permission review already shows (`name`, `version`, `title`, `description`, `permissions`), readable **before** downloading the whole package;
- an integrity check (a SHA-256 of the `.zip`) so the bytes installed are the bytes listed;
- optionally a publisher signature, so "reviewed" can mean something;
- the same strict unpacking, size limits and "off until enabled" rule as an upload. A registry never skips the review step.

## Options

### Option A: A static JSON index (GitHub Pages or a CDN) pointing at `.zip` files

A repository holds `index.json`: one entry per plugin with name, versions, `plugin.json` summary, download URL and SHA-256. Plugins are added by pull request to that repository; the index and the packages are served as static files. A site reads `PLUGIN_REGISTRY_URL` (default: the official index, replaceable by a private one).

- Trust and signing: the index can be signed with one maintainer key whose public half ships with NodePress; the pull request review is the review. Checksums are in the index itself.
- Hosting cost: effectively zero (static hosting).
- Review workload: every listing is a human-reviewed pull request, which is slow but is exactly the "reviewed marketplace" PLAN.md describes.
- Offline installs: easy. The index and a package can be mirrored, or the `.zip` uploaded as today.
- Fit with N28: direct. The index carries the permissions, so the review dialog can show them before download.
- Cons: no search service, ratings or download counts; the index grows as one file (fine for hundreds of plugins, then needs sharding); authors need a pull request to publish.

### Option B: npm packages with a `nodepress-plugin` keyword

Plugins are published to npm. The admin searches the npm search API for the keyword and installs the tarball.

- Trust and signing: npm provenance and registry signatures cover integrity and publisher identity, but anyone can publish under the keyword, so there is no review. Typosquatting and abandoned packages are real risks.
- Hosting cost: none.
- Review workload: none, which is the problem; a curated allowlist would have to be added on top.
- Offline installs: possible with a private npm mirror, harder than A for a plain site.
- Fit with N28: weaker. Permissions live inside the tarball, so the full package must be downloaded to show the review. npm packages also bring their own dependencies and install scripts, while a NodePress plugin is a pre-built folder; installing would need either bundling rules or running `npm install` on the server, which is the riskiest option for a CMS process. Docker installs are awkward too (node_modules written at run time).
- Pro: authors already know npm, and it connects to ADR 0002 option A (packages on npm).

### Option C: GitHub releases

A plugin is a GitHub repository; installing means giving `owner/repo`, and the server downloads the `.zip` asset of a release and its checksum file.

- Trust and signing: GitHub shows who owns the repository and can attest releases, but there is again no review and no central discovery; "install by repo URL" invites installing the wrong thing.
- Hosting cost: none. Rate limits for unauthenticated API calls apply (60 requests an hour per IP), which matters on shared hosts.
- Review workload: none unless combined with a list.
- Offline installs: same as an upload once the asset is downloaded.
- Fit with N28: the permissions are inside the asset, so the same review-after-download problem as B, though a small `plugin.json` can also be fetched raw.
- Best as a *source* behind another index (the index entry points at a release asset) rather than as the registry itself.

### Option D: A hosted NodePress registry service

An API with accounts, publishing, search, ratings, download counts, automated checks and a review queue.

- Trust and signing: the strongest story (server-side scans, signed packages, takedowns, publisher verification).
- Hosting cost: a server, a database, storage, abuse handling and an on-call owner.
- Review workload: highest; someone must run the queue.
- Offline installs: needs a mirror story.
- Fit with N28: good (an API can return the permission summary first).
- Cons: a product of its own, far more than a one-person project needs before there are plugins to list. It also makes every site depend on one service.

## Trade-off summary

| | A: static index | B: npm | C: GitHub releases | D: hosted service |
| --- | --- | --- | --- | --- |
| Reviewed listings | yes (pull requests) | no | no | yes (queue) |
| Integrity | SHA-256 and optional signature | npm signatures, provenance | checksum file | server-side signing |
| Permissions visible before download | yes | no | partly | yes |
| Running cost | about zero | none | none | real |
| Works offline or private | yes (mirror the files) | with a mirror | after download | needs mirror |
| Build effort | small | medium (and install-time risk) | small | large |

## Recommendation

Option A, with Option C as the place packages are hosted and Option D as a later step if the ecosystem outgrows it.

Concretely: an `index.json` in a public `nodepress/registry` repository (served by GitHub Pages), where each entry holds the `plugin.json` summary, a version list, a download URL (a GitHub release asset or any HTTPS URL) and the SHA-256 of the `.zip`. Listing a plugin is a reviewed pull request. The server fetches the index (cache it; allow `PLUGIN_REGISTRY_URL` to point at a private index or turn the registry off), shows the entry's permissions in the existing review dialog, downloads the `.zip`, refuses it if the SHA-256 differs, and hands it to the same strict unpacker used for uploads, leaving it off until enabled. Sign the index with a maintainer key from the first release so verification does not have to be retrofitted. Updates (N38) can reuse the same index, which keeps one source of truth for what is installable.

This keeps the security model PLAN.md already states (reviewed, checksummed, permissions shown before install), costs nothing to host, and works for self-hosters who cannot reach the internet from the server.

## What this changes in the queue

If A is chosen, the follow-up task "Install plugins from a registry" can be built: index format and validation, fetch with caching and timeouts, SHA-256 and signature check, a "Registry" tab on the Plugins screen, and `nodepress plugin install <name>` in the CLI. If B, C or D is chosen, that task's scope needs rewriting first. The decision also feeds N38 (updater), which should read the same index for plugin updates.

## Open questions for the owner

- Who holds the index signing key, and how is it rotated?
- Is a private or company registry (`PLUGIN_REGISTRY_URL`) a launch requirement?
- Should the first release ship with the registry empty (only first-party plugins listed)?
