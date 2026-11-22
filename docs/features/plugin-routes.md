# Plugin routes and database access

## HTTP routes

A plugin adds routes in `setup()` with `context.routes.add()`. They are served under `/api/v1/plugins/<plugin name>/` and removed when the plugin is deactivated (or when its `setup()` throws).

```ts
setup({ routes }) {
  routes.add({
    method: 'GET', // GET, POST, PUT, PATCH or DELETE
    path: '/items/:id', // starts with "/", ":name" segments are captured in params
    capability: 'edit_posts', // a capability name, or 'public' for anyone
    handler: async ({ params, query, json, user }) => ({ status: 200, json: { id: params.id } }),
  });
}
```

- **Who may call it** is decided by the server before the handler runs. With a capability name the caller must be signed in (a session cookie with the `x-csrf-token` header for writes, or a Bearer API token) and hold the capability: otherwise the answer is `401` or `403`. A `public` route needs nothing, so use it only for things that are safe for the whole internet and validate every input.
- The handler gets `{ method, path, params, query, headers, user, json() }`; `json()` reads the body (up to 1 MB) and a body that is not JSON answers `400`. It returns `{ status?, json?, text?, headers? }`. A plugin cannot set cookies or security headers, and answers are `Cache-Control: no-store` unless the plugin sets another value.
- A handler that throws answers `500 { "error": "plugin_error" }` (the details are only in the log) and a handler that runs longer than 30 seconds answers `504`; other routes and the site are not affected.
- A request that matches no plugin route falls through to the rest of the API (`404`).
- The admin's Plugins screen lists the web addresses a running plugin added. The routes only exist while the plugin runs, so the list is not part of the question "enable this plugin?"; read the plugin's code or docs for that.

The routes are described in a small framework-independent shape (`PluginRouteDefinition` in `@nodepress/core`), not as a Hono router, so plugins do not depend on the web framework.

## Database access

A plugin whose `plugin.json` declares the `database` permission gets `context.db` (when the site has a database to give). It owns the tables whose names start with its name and `_` (`my-plugin` → `my_plugin_`); create them in a migration (see `plugin-packages.md`).

```ts
const rows = await db.query('SELECT id, title FROM my_plugin_notes WHERE owner = ? LIMIT ?', [
  userId,
  20,
]);
await db.execute('INSERT INTO my_plugin_notes (owner, title) VALUES (?, ?)', [userId, title]);
```

- Values are passed separately and bound as parameters (`?` in the text, `$1…` on PostgreSQL); they never become part of the SQL.
- Only `SELECT` (`query`) and `INSERT`, `UPDATE`, `DELETE` (`execute`) are allowed, one statement at a time. Quotes, brackets, comments, `;` inside a statement, `PRAGMA`, `CREATE`/`DROP`/`ALTER`, system tables and table-valued functions are refused, so there are no string literals: write every value as a `?`.
- Every table named after `FROM`, `JOIN`, `INTO` or `UPDATE` (also after a comma in a `FROM` list, and in subqueries) must start with the plugin's prefix, so a plugin cannot read or change core tables or another plugin's tables through `context.db`.

This is a guard against mistakes and an easy-to-review limit, not a sandbox: plugin code runs in the site's process, and its migrations run unrestricted SQL, which is why the `database` permission is shown to the site owner before a plugin is enabled.
