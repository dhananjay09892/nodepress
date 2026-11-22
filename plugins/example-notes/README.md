# Example notes

A complete example plugin for the [plugin guide](../../apps/docs/src/content/docs/guides/plugins.md): private notes for each editor, kept in the plugin's own table.

- `plugin.json`: name, `database` permission, entry.
- `migrations/`: the table, for SQLite and PostgreSQL.
- `src/index.ts`: three routes (`GET`, `POST` and `DELETE` under `/api/v1/plugins/example-notes/notes`) with `edit_posts`, parameterized queries through `context.db`.
- `src/index.test.ts`: runs the migration and the routes against an in-memory database.

```bash
pnpm --filter @nodepress/plugin-example-notes build
nodepress plugin check plugins/example-notes
nodepress plugin pack plugins/example-notes
```
