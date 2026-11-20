# Database

The database layer is `packages/db`: Drizzle ORM with one schema for SQLite/libSQL (`schema.ts`) and one for PostgreSQL (`schema.pg.ts`), each with its own committed migration folder under `packages/db/drizzle/`. `drizzle-orm` is on 0.45.2 or later (earlier versions have an SQL injection advisory for improperly escaped identifiers; NodePress only uses fixed identifiers from its own schema, so the fix is defence in depth) and `drizzle-kit` on 0.31. Run `pnpm --filter @nodepress/db db:generate` after a schema change and commit the new migration files.
