import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files that talk to PostgreSQL wipe and rebuild the shared test database.
    fileParallelism: false,
  },
});
