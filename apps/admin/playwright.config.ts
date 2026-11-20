import { defineConfig } from '@playwright/test';

const PORT = 3100;
const INSTALL_PORT = 3101;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  // Boots the real server (build everything first with `pnpm build`) on a throwaway database.
  webServer: [
    {
      command: 'node ../server/dist/main.js',
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: String(PORT),
        DATABASE_URL: 'file:./e2e.db',
        PLUGINS_DIR: './e2e-plugins',
        SITE_NAME: 'E2E Site',
        COOKIE_SECURE: 'false',
        ADMIN_EMAIL: 'admin@example.test',
        ADMIN_PASSWORD: 'e2e-test-password-1',
      },
    },
    {
      // A second, empty site for the web installer: no users, so the wizard is shown.
      command: 'rm -f ./e2e-install.db && node ../server/dist/main.js',
      url: `http://localhost:${INSTALL_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(INSTALL_PORT),
        DATABASE_URL: 'file:./e2e-install.db',
        PLUGINS_DIR: './e2e-install-plugins',
        INSTALL_CODE: 'e2e-setup-code',
        COOKIE_SECURE: 'false',
      },
    },
  ],
});
