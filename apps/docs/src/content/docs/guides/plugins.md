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
