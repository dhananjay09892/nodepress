# Analytics plugin

The **analytics plugin** (`plugins/analytics`, on by default) counts page views and visitors without cookies and without storing IP addresses. It is a real plugin: it uses only the plugin API (routes, database, jobs, admin settings, a hook), and its tables are created by its own migrations (`migrations/sqlite` and `migrations/postgres`).

## What is counted

- Every page the theme renders gets `<script src="/api/v1/plugins/analytics/script.js" defer>` before `</body>` (added through the `render:html` filter, not on `/admin` or `/api`) and, inside `<noscript>`, a 1×1 pixel `hit.gif?p=<path>` for visitors without JavaScript. The script sends one `navigator.sendBeacon` with the path and the external `document.referrer`; it does nothing when the browser says Do Not Track or Global Privacy Control, and it sets no cookie and uses no storage.
- The server ignores a hit when the request has `DNT: 1` or `Sec-GPC: 1`, when the user agent is empty or names a crawler, monitor or link-preview fetcher (`Googlebot`, `bingbot`, `curl`, `UptimeRobot`, `Lighthouse`, …), or when the path is not a page of the site. Headless Chrome is counted on purpose, so end-to-end tests can see their own visits.
- Per day it keeps: page views per path and referrer host (`analytics_views`), and the number of distinct visitors (`analytics_days`). The referrer is only the host of an outside site (`news.example.com`, `www.` removed); the site itself and non-http referrers are dropped.
- At most 2000 different (path, referrer) rows are kept per day; further ones are counted under `/other`, so a script that invents paths cannot fill the database.

## Privacy

- **No IP address, no user agent and no cookie is stored, ever.** A visitor is `sha256(salt, address, user agent)`, used only to count each visitor once per day. The salt is 32 random bytes held **in memory** for one UTC day; the next day gets a new one and the old one is forgotten. The hashes are stored under their day only (`analytics_visitors`), cannot be linked across days, and are deleted when the day changes or by the nightly job, whichever comes first.
- Tests check that no table holds an address or user agent, that no column could, and that the pixel sets no cookie.
- Because the salt is not saved, a server restart during the day starts a new salt, so a visitor who comes back after the restart is counted once more that day. With several server processes each counts its own visitors; this is an accepted trade-off for never persisting the salt.
- The address comes from the socket (or `X-Forwarded-For` when `TRUST_PROXY=true`); the plugin routes now pass it to handlers as `request.clientIp`.
- The hit routes are public, so anyone can send fake hits; the counts are for a rough picture, not for billing.

## The Analytics screen

The **Analytics** item in the admin menu opens a report page contributed by the plugin through the admin extension points (see `admin-reports.md`; hidden without `manage_options`): totals for page views and visitors, a bar chart per day with a table of the same numbers under "Show per day as a table", the top pages and the top referrers. It covers the last 30 days; the **From** and **To** fields (UTC days, not in the future, at most 366 days) and the **Last 7/30/90 days** buttons change the range, and a range the route would refuse is explained next to the fields before anything is requested. A day's views and visitors are the counts of that UTC day, so today's numbers keep growing until midnight UTC.

## Settings and retention

The **Analytics retention** item in the admin menu (its page is titled "Analytics settings"; the menu label avoids the word "Settings" so it is not confused with the core Settings entry) opens a page (administrators, `manage_options`) with one setting, **Keep data for (days)**, default 90, at most 3650. A scheduled job (`analytics:prune`, first run a minute after start, then every 24 hours) deletes older rows. A job left over from an earlier start ends without running, so restarts never start two chains.

## API

`GET /api/v1/plugins/analytics/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` needs `manage_options` (session or Bearer token). Without parameters it covers the last 30 days; a range is at most 366 days (`400` otherwise). The answer:

```json
{
  "from": "2026-10-26",
  "to": "2026-11-24",
  "totals": { "views": 120, "visitors": 45 },
  "days": [{ "day": "2026-10-26", "views": 3, "visitors": 2 }],
  "pages": [{ "path": "/hello", "views": 40 }],
  "referrers": [{ "host": "news.example.com", "views": 12 }]
}
```

`days` has a row for every day (zeros included, oldest first); `totals.visitors` is the sum of the daily visitors (a visitor on two days counts twice). `pages` and `referrers` are the top 20 by views.

The public routes are `GET /hit.gif?p=<path>[&r=<referrer>]` (answers the GIF) and `POST /hit?p=<path>[&r=<referrer>]` (answers `204`), plus `GET /script.js`.

## Plugin API additions

Written for this plugin and available to every plugin: `request.clientIp`, a route answer with `bytes` (binary body), and a `Content-Type` set in a route's `headers` is honored for `text` and `bytes` answers (see `plugin-routes.md`).
