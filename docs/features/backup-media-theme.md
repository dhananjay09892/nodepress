# Backup: media zip and theme settings

## Media zip

`GET /api/v1/backup/media` (`manage_options`) downloads every original file of the media library as one zip (`nodepress-media-<date>.zip`): the files under `media/<id>.<ext>` and a `manifest.json` with each file's id, MIME type, alt text and size. Sizes (variants) are not included; they are made again when the zip is restored. A file that is missing from storage, or that would take the zip past 256 MB of file data (or 20,000 files), is left out and named in `manifest.omitted`; the `x-nodepress-media-omitted` response header holds the count.

`POST /api/v1/backup/media` (`application/zip`, up to 256 MB) restores such a zip. Every file goes through the media service, so type detection, size, pixel and variant rules apply exactly as for an upload (a `.php` file renamed to `.png` is refused). The reader is the strict zip reader used for plugin packages (no absolute or `..` paths, no encryption, no zip bombs). A bad zip or manifest changes nothing; a refused file is listed in `failed` and the rest go on. Files are added next to the existing ones.

### Pointing posts at the restored files

Restore the media zip **first**, then the JSON backup. The old → new media ids of the last media restore are kept in the option `backup_media_map` and used by the next `POST /api/v1/backup/import`, which then:

- sets `featured_image` to the new id (and leaves it out, with a warning, when the file was not restored),
- replaces the `mediaId` of `core/image` blocks, also in nested blocks.

The map is used once and then removed. Without a restored media zip the JSON import behaves as before and leaves `featured_image` out.

## Theme settings

The JSON export has a `themeSettings` entry (`{ theme, values }`) with the customizer values saved for the active theme. On import they are applied only when the same theme is active, and only through the theme settings service, which checks every key and value against the theme's `theme.json`; a file that does not fit changes nothing and a warning says why. The import summary has `themeSettings: { applied, reason? }`.

## Admin screen

The Backup screen has a **Media files** section: a **Download media zip** link and a **Restore media** form (shows the restored count and the files that were refused).
