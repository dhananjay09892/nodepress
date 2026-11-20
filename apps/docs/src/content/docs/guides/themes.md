---
title: Build a theme
description: Make a TSX theme with WordPress-style templates.
---

A theme is a folder with a `theme.json` and templates. Start from the Starter theme:

```bash
nodepress theme create my-theme
```

## theme.json

`name` must equal the folder name. `version` is required; `title`, `description`, `supports` and `settings` are optional. Settings declare a schema and defaults; overrides are checked against it.

## Templates

Templates are TSX components with a default export. They receive `siteName`, `path`, `status`, `content`, `html` and `theme.assetsUrl`, and return markup. The template tried first depends on what is shown:

- Pages: `page-{slug}`, then `page`, `single`, `index`.
- Other content: `single-{type}`, then `single`, `index`.
- Not found: `404`, then `index`.
- Front page: `front`, then `index`. It also receives `tagline`, `posts` and `settings`.

Plugins can change the list of names tried with the `template:resolve` filter.

## Assets

Files in the theme's `assets` folder are served at `/themes/<name>/assets/...` with caching headers.

## Activating

Set `THEME` to the folder name. Themes are read from `./themes` (`THEMES_DIR` overrides). If a theme is missing or a template throws, the built-in page is shown, so a theme can never take the site down.
