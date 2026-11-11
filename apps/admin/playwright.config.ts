import { defineConfig } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  // Boots the real server (build everything first with `pnpm build`) on a throwaway database.
  webServer: {
    command: 'node ../server/dist/main.js',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      DATABASE_URL: 'file:./e2e.db',
      SITE_NAME: 'E2E Site',
      COOKIE_SECURE: 'false',
      ADMIN_EMAIL: 'admin@example.test',
      ADMIN_PASSWORD: 'e2e-test-password-1',
    },
  },
});
