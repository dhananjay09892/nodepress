import { expect, test } from '@playwright/test';

const EMAIL = 'admin@example.test';
const PASSWORD = 'e2e-test-password-1';

test('anonymous visitors are sent to the login screen', async ({ page }) => {
  await page.goto('/admin/');
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to NodePress' })).toBeVisible();
});

test('a wrong password shows an error and stays on the login screen', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test('sign in, navigate, reload, sign out', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/admin\/$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('current-user')).toHaveText('Administrator');

  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Posts' }).click();
  await expect(page).toHaveURL(/\/admin\/posts$/);
  await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible();

  // The session cookie survives a reload and deep links work.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);

  // Signed out for real: the shell is out of reach again.
  await page.goto('/admin/posts');
  await expect(page).toHaveURL(/\/admin\/login$/);
});
