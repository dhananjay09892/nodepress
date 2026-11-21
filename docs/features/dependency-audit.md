# Dependency audit

CI runs `pnpm audit --prod --audit-level=high` in a blocking job (N62). The job does not install dependencies, so it turns the automatic pnpm cache of `actions/setup-node` off (`package-manager-cache: false`); with it on, the job failed in the post step with "Path Validation Error" even though the audit itself passed. `zod` is on 4.6.6 or later (the 3.x line has the memory-exhaustion advisory and no fix); it validates the content-type definitions, custom field values and the backup import. Open findings are listed in `docs/security-review.md`.
