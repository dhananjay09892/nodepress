# S3-compatible media storage

Uploads go to local disk (`MEDIA_DIR`) by default. Container hosts (Railway, Render, Fly.io) lose their disk on redeploy unless a volume is attached, so NodePress can store media in an S3-compatible bucket instead: AWS S3, Cloudflare R2, MinIO, Backblaze B2.

## Settings

| Variable               | Needed | Meaning                                                                           |
| ---------------------- | ------ | --------------------------------------------------------------------------------- |
| `MEDIA_STORAGE`        | yes    | `s3` turns this on. Empty or `local` keeps the disk (`MEDIA_DIR`).                |
| `S3_BUCKET`            | yes    | Bucket name (lower case; 3 to 63 characters).                                     |
| `S3_REGION`            | yes    | e.g. `us-east-1`; use `auto` for Cloudflare R2.                                   |
| `S3_ACCESS_KEY_ID`     | yes    | Access key with permission to put, get and delete objects in the bucket.          |
| `S3_SECRET_ACCESS_KEY` | yes    | The secret. Never logged, never returned by the API, never part of an error text. |
| `S3_ENDPOINT`          | no     | Service address for non-AWS services, e.g. `http://minio:9000`.                   |
| `S3_PUBLIC_URL`        | no     | Where browsers load files from (bucket website, CDN). See below.                  |

A missing or malformed setting stops the server at start with a message that names the variable (never its value).

## How it works

- `createS3Storage()` in `@nodepress/core` implements the `StorageAdapter` interface with `fetch` and AWS Signature V4 written on `node:crypto`; there is no SDK dependency. The signer is checked against AWS's published example signatures.
- With `S3_ENDPOINT` the bucket is addressed in the path (`https://host/bucket/key`), which MinIO needs. Without it, AWS virtual-hosted style (`https://bucket.s3.region.amazonaws.com/key`) is used, and path-style on AWS for bucket names with dots.
- Keys are the same as on disk (`uploads/2026/11/name-1a2b3c4d.jpg`) and pass the same validation before any request is made.
- Uploads send `If-None-Match: *`, so services that support conditional writes refuse to overwrite. They also send `Cache-Control: public, max-age=31536000, immutable` and the checked content type.
- Redirects are not followed (a signed request must not be resent elsewhere); requests time out after 30 seconds.
- Errors contain the HTTP status and the service's error code only.

## Serving files

- Without `S3_PUBLIC_URL`, files are read from the bucket and served by the existing `/uploads/*` route, with the same safe headers as local files (`nosniff`, a locked-down CSP, PDFs as downloads). The bucket can stay private.
- With `S3_PUBLIC_URL`, the media API returns absolute URLs (`https://cdn.example.com/uploads/...`) and browsers load files straight from there. The bucket (or CDN) must allow public reads of `uploads/*`, and it will not add NodePress's `nosniff` and CSP headers: set them on the CDN, and keep SVG and HTML out of the bucket. `/uploads/*` keeps working through NodePress as a fallback.

## Not built yet

- No migration tool for moving existing local files into a bucket (the Backup screen's media zip can restore them through the new storage).
- No multipart upload: the largest upload is capped by `MAX_UPLOAD_BYTES` (10 MiB by default), which a single PUT handles.
