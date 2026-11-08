import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.pg.ts',
  out: './drizzle/postgres',
});
