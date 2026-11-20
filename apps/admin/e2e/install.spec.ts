import { expect, test } from '@playwright/test';

// The empty site on its own port (see playwright.config.ts): no users, so the wizard is shown.
const SITE = 'http://localhost:3101';

test('the setup wizard checks the server, creates the administrator and opens the admin', async ({
  page,
}) => {
  // The front page sends a fresh site to the wizard.
  await page.goto(`${SITE}/`);
  await expect(page).toHaveURL(`${SITE}/install`);
  await expect(page.getByRole('heading', { name: 'Set up NodePress' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Database connected');

  // Step 1: the setup code from the server log (INSTALL_CODE here). A wrong one is refused.
  await page.getByLabel('Setup code').fill('wrong-code');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Site name').fill('Wizard Site');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Email').fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('a-long-setup-password');
  await page.getByLabel('Repeat the password').fill('a-long-setup-password');
  await page.getByRole('button', { name: 'Install NodePress' }).click();
  await expect(page.getByLabel('Setup code')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'setup code' })).toBeVisible();

  // The right code finishes the setup, then the screens already filled in are still there.
  await page.getByLabel('Setup code').fill('e2e-setup-code');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill('a-long-setup-password');
  await page.getByLabel('Repeat the password').fill('a-long-setup-password');
  await page.getByRole('button', { name: 'Install NodePress' }).click();

  await expect(page).toHaveURL(`${SITE}/admin/login`);
  await page.getByLabel('Email').fill('owner@example.test');
  await page.getByLabel('Password').fill('a-long-setup-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // The wizard is gone and the site shows the chosen name.
  await page.goto(`${SITE}/install`);
  await expect(page).not.toHaveURL(/\/install/);
  const home = await page.request.get(`${SITE}/`);
  expect(home.status()).toBe(200);
  expect(await home.text()).toContain('Wizard Site');
});
