# Web installer

A site with no users shows a setup wizard, for hosting without a terminal. Visitors of any page are sent to `/install` (API calls and the wizard itself are not redirected) until the first administrator exists.

1. **Check your server**: the page asks the server for `GET /api/v1/install/status` and shows whether the database (SQLite or PostgreSQL, set by `DATABASE_URL`) is connected and migrated. The visitor enters the **setup code**.
2. **Your site**: the site name (saved as the `site_title` setting).
3. **Administrator account**: email, password (at least 10 characters, entered twice).

The wizard posts `POST /api/v1/install` and then opens the admin to sign in.

## Setup code

Anyone who reaches a fresh site could otherwise become its administrator. The server prints a random code in its log at start (`Setup is waiting: …`); set `INSTALL_CODE` (8+ characters) to choose one instead. Only a visitor who knows it can finish the setup. Wrong codes are rate limited (10 per 15 minutes) and compared in constant time. The wizard stays off once any user exists, and it is not started at all when the site already has users at boot, including when `ADMIN_EMAIL` and `ADMIN_PASSWORD` created the first one.

## Site name

`SITE_NAME` still wins when set. Otherwise the name stored as `site_title` (by the wizard or the Settings screen) is read at start, and the wizard applies its choice immediately.

## Notes

- The page and its script (`/install/install.js`) work with the default Content-Security-Policy (no inline script) and have labelled fields, announced errors and a dark mode.
- Playwright (`apps/admin/e2e/install.spec.ts`) runs the wizard against a second, empty server on port 3101.
- CI jobs that start a server on an empty database (Lighthouse) set `ADMIN_EMAIL` and `ADMIN_PASSWORD`, or they would audit the wizard.
