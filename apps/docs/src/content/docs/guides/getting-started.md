---
title: Getting started
description: Run NodePress on your machine or in Docker and sign in.
---

You need Node.js 22 or newer and pnpm 9 or newer.

```bash
pnpm install
pnpm build
pnpm dev
```

The site is at `http://localhost:3000` and the admin at `http://localhost:3000/admin/`.

## First run

On a new database no user exists yet. NodePress prints a setup code in its log and serves `/install`, where you enter that code, the site title and your first administrator. Once a user exists the page is gone.

## Configuration

Settings come from environment variables; `.env.example` lists them all. The ones you will meet first:

- `PORT` is the port to listen on (default 3000).
- `DATABASE_URL` is `file:...` for SQLite or a `postgres://` URL.
- `THEME` is the active theme folder (default `aurora`).
- `PLUGINS_DIR` is where installed plugin packages live.

## Docker

The repository's `Dockerfile` builds the server, admin, themes and plugins. Mount a volume at `/data`: it keeps the database, uploads and installed plugins.

## Command line

`nodepress migrate` applies database migrations, `nodepress dev` runs the server and restarts it when files change, and `nodepress plugin` and `nodepress theme` scaffold, check and pack extensions. See the [plugin guide](/guides/plugins/) and [theme guide](/guides/themes/).

## Moving from WordPress

In WordPress choose Tools, then Export, then All content. In the NodePress admin open Import and upload the `.xml` file. Posts, pages, categories and tags are added next to what you have, and old addresses become redirects.
