# Backup: menus, widgets and redirects, and the Backup screen

The export (`GET /api/v1/backup/export`) now also holds the site's **menus** (with the menu location each is assigned to), the **widgets** placed in the active theme's areas, and the **redirect rules**, next to content, custom fields, terms and settings. The file format stays version 1: the new parts are optional, so exports made before still import, and a site that cannot manage one of them leaves it out.

Restoring (`POST /api/v1/backup/import`) only adds, like the rest of the import:

- menus are created next to the existing ones (each item is checked by the menu service);
- a menu location gets its menu only if it has none yet, a widget area gets its widgets only if it is empty, and locations or areas the active theme does not have are skipped, each with a warning;
- a menu widget is pointed at the new id of its menu, and left out if the menu could not be restored;
- redirect rules go through the redirects service (invalid ones, such as a rule for `/admin`, and rules for a path that already has one are reported in the warnings).

The summary gains `menus`, `widgets` and `redirects` counts.

## Admin screen

"Backup" in the sidebar (administrators): a **Download backup** link and a **Restore a backup** form (choose the `.json` file, see the result with skipped items and warnings). `GET /api/v1/backup` returns `{ maxBytes }` so the screen can check the file size and hide itself from users who may not use backups.

## Not yet

Uploaded media files and theme settings are covered in [backup-media-theme.md](./backup-media-theme.md) (N65).
