---
title: Write a plugin
description: Create, check and install a NodePress plugin.
---

A plugin is a folder with a `plugin.json` and an entry module whose default export is made with `definePlugin`. A failing plugin never takes the site down: errors are logged and the plugin is skipped.

## Create one

```bash
nodepress plugin create my-plugin
```

This writes `plugin.json`, `package.json`, a plain-JavaScript `index.js` that needs no build step, and a README into `./plugins-installed/my-plugin`.

## The entry module

```js
import { definePlugin } from '@nodepress/sdk';

export default definePlugin({
  name: 'my-plugin',
  version: '0.1.0',
  setup({ hooks, logger }) {
    // An action: something happened.
    hooks.addAction('core:ready', () => logger.info('Hello'));

    // A filter: change a value on its way through.
    hooks.addFilter('content-type:definitions', (types) => types);
  },
});
```

Actions and filters are listed in the [hooks reference](/reference/hooks/). Plugins can also add pages and fields to the admin; the `hello-nodepress` plugin in the repository shows a settings page and an extra field on the post screen.

## Permissions and migrations

`plugin.json` declares `permissions` (such as `content:read`, `options:write` or `network`) so the owner can review them. They are not a sandbox, and only `database` is enforced: a plugin with a `migrations` folder must declare it. Migrations are `.sql` files in `migrations/sqlite/` and `migrations/postgres/`, run once each in file name order.

## Check, pack, install

```bash
nodepress plugin check ./plugins-installed/my-plugin
nodepress plugin pack ./plugins-installed/my-plugin
```

`check` validates `plugin.json` and loads the entry with the same code the server uses. `pack` writes `my-plugin-0.1.0.zip`, ready to upload on the admin's Plugins screen. A plugin found on disk is off until you turn it on, and changes apply at the next start.

## A worked example: private notes

`plugins/example-notes` in the repository is a small, complete plugin: three HTTP routes, a table of its own and a migration. Every code block below is copied from its source files, and a test keeps them in step.

### plugin.json

The plugin declares `database`, because it has a `migrations` folder and runs queries.

```json title="plugins/example-notes/plugin.json"
{
  "name": "example-notes",
  "version": "0.1.0",
  "title": "Example notes",
  "description": "Private notes for editors: HTTP routes, a database table and a migration.",
  "permissions": ["database"],
  "entry": "dist/index.js"
}
```

### The table

Tables a plugin uses must start with its name, with dashes turned into underscores: `example-notes` owns `example_notes_`. The migration for SQLite is below; add a matching file under `migrations/postgres/`.

```sql title="plugins/example-notes/migrations/sqlite/0001_create_notes.sql"
CREATE TABLE example_notes_items (
  id integer PRIMARY KEY AUTOINCREMENT,
  owner_id integer NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL
);
-- statement-breakpoint
CREATE INDEX example_notes_items_owner ON example_notes_items (owner_id);
```

### Routes

Routes are added in `setup` and appear under `/api/v1/plugins/example-notes/`. Each names the capability a caller needs; the server answers 401 or 403 before your handler runs.

```ts title="plugins/example-notes/src/index.ts"
routes.add({ method: 'GET', path: '/notes', capability: 'edit_posts', handler: handlers.list });
```

### Database access

`context.db` takes one statement with `?` placeholders and a list of values. Values never become part of the SQL text, and the statement may only name the plugin's own tables. String literals and quotes are not allowed in the statement, so pass text as values.

```ts title="plugins/example-notes/src/index.ts"
await db.execute('DELETE FROM example_notes_items WHERE id = ? AND owner_id = ?', [
  id,
  owner(request),
]);
```

### Try it

Build it (`pnpm --filter @nodepress/plugin-example-notes build`), copy the folder with its `dist` into `PLUGINS_DIR` (or run `nodepress plugin pack`, then upload the zip), turn the plugin on, restart, and call it with a session or API token:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"Buy milk"}' http://localhost:3000/api/v1/plugins/example-notes/notes
```
