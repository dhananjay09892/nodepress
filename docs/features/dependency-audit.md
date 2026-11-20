# Dependency audit

CI runs `pnpm audit --prod --audit-level=high` in a job that reports without blocking (`continue-on-error`); N62 makes it blocking once it is clean. `zod` is on 4.6.6 or later (the 3.x line has the memory-exhaustion advisory and no fix); it validates the content-type definitions, custom field values and the backup import. Open findings are listed in `docs/security-review.md`.
