# Plugin author guide and example plugin

`plugins/example-notes` is a complete example plugin: private notes for editors, with three HTTP routes (`GET` and `POST /notes`, `DELETE /notes/:id`, all needing `edit_posts`), its own table `example_notes_items` created by a migration, and the `database` permission.

The guide at `apps/docs/src/content/docs/guides/plugins.md` walks through it. Its code blocks carry `title="path"` and are checked by `apps/docs/scripts/guide-snippets.test.ts`, which fails when a block is no longer an exact excerpt of the file it names, so the guide cannot drift from the code.

`@nodepress/sdk` re-exports the plugin route and database types (`PluginDatabase`, `PluginRouteHandler`, `PluginRouteRequest`, …) so a plugin imports everything from one place.

The plugin's behavior is tested in `apps/server/src/example-notes-plugin.test.ts` against a real in-memory SQLite database and the real migration file.
