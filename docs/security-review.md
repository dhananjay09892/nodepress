# Security review (N39, first pass)

Scope of this pass: browser-facing headers, the upload serving path, and a check of the other protections the README claims against the code and tests that already exist. It is a review by the builder, not an audit by a third party.

## Findings

| #   | Finding                                                                                                                             | Status                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | No Content-Security-Policy, framing, referrer or MIME-sniffing headers on pages, the admin or the API (only uploads had their own). | Fixed: `securityHeaders` middleware, tested, outermost so cached pages get it too.                                                                                 |
| 2   | No `Strict-Transport-Security` over HTTPS.                                                                                          | Fixed: sent on HTTPS (or a trusted `X-Forwarded-Proto`), off with `HSTS=off`.                                                                                      |
| 3   | No dependency audit in CI.                                                                                                          | Fixed: a non-blocking `audit` job reports high and critical advisories for production dependencies; Dependabot proposes weekly updates for npm and GitHub Actions. |
| 4   | No `SECURITY.md`.                                                                                                                   | Fixed: reporting route, what is protected, known limits.                                                                                                           |
| 5   | The CSP allows inline styles (`style-src 'unsafe-inline'`) because themes and the editor use them.                                  | Accepted for now; script injection is still blocked. Follow-up N62 removes it where possible.                                                                      |
| 6   | Rate limits (login, contact form) are in memory per process.                                                                        | Documented in `SECURITY.md`. A shared store is future work for multi-instance deployments.                                                                         |
| 7   | Plugins are trusted code; permissions are declared, not enforced, except `database`.                                                | Documented in `SECURITY.md` and the plugin screen text; sandboxing is out of scope for 1.0 (see PLAN.md).                                                          |

## Checked and found as claimed

- Uploads (`createUploadsHandler`, `MediaService`): only `uploads/` keys with a known extension are served, with `nosniff`, `default-src 'none'; sandbox` and immutable caching; PDFs are `attachment`; the stored type comes from the bytes, mismatches are refused, and size and pixel limits apply.
- Cookies, CSRF and login limits: covered by the existing auth tests.
- Redirect rules and the WordPress import map: tested against `//host` and reserved paths.

## Not covered in this pass

A review of every API route's capability checks, the admin app's own output encoding, and fuzzing of the importers. They belong in the follow-up below.
