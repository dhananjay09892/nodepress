# WordPress import: media download

When the server has a media library (`wordpressImport.media` in `createApp`, set in `main.ts`), `POST /api/v1/import/wordpress` copies the images of the export into it. Add `?download_media=false` to skip this and only list the files.

- Each attachment is fetched once with a guarded downloader (`downloadFile` in `@nodepress/core`): `http` and `https` only, no credentials in the address, no loopback, private or `.local` hosts (checked again on every redirect and on the DNS answer), at most 3 redirects, 10 MB per file and 20 seconds per file. Three files are fetched at a time and an import takes at most 500 files; the rest are reported as not downloaded.
- Files go through `MediaService.upload`, so type, size and pixel checks and image variants apply. A file the media library refuses is reported, not fatal.
- Image addresses in imported content (including size variants such as `photo-300x200.jpg` and `-scaled`) are replaced by the new address, and the `_thumbnail_id` of a post becomes its `featured_image` field.
- The report has a `media` object: `imported` (old address, new media id and address), `failed` (address and reason, so the import can be repeated for them), `imagesRewritten` and `featuredImages`.

Library use: pass `importMedia(file)` to `importWordPress`; it should return `{ id, url }` for the stored file. `mediaConcurrency` and `maxMediaFiles` tune the limits.
