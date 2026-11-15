import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'admin@example.test';
const PASSWORD = 'e2e-test-password-1';

async function signIn(page: Page) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
}

async function openSettings(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Settings' })
    .click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
}

test('change the site title and see it persisted after a reload', async ({ page }) => {
  const title = `Field Notes ${Date.now()}`;
  await signIn(page);
  await openSettings(page);

  const save = page.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeDisabled();
  await page.getByLabel('Site title').fill(title);
  await page.getByLabel('Tagline').fill('Notes from the field');
  await save.click();
  await expect(page.getByRole('status')).toHaveText('General settings saved.');

  await page.reload();
  await expect(page.getByLabel('Site title')).toHaveValue(title);
  await expect(page.getByLabel('Tagline')).toHaveValue('Notes from the field');
});

test('reading settings: posts per page is validated and then saved', async ({ page }) => {
  await signIn(page);
  await openSettings(page);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Reading' }).click();

  const perPage = page.getByLabel('Posts per page');
  await perPage.fill('500');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('whole number from 1 to 100');

  await perPage.fill('7');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Reading settings saved.');
  await page.reload();
  await expect(page.getByLabel('Posts per page')).toHaveValue('7');
});

test('permalinks: choose a preset and an invalid custom pattern is refused', async ({ page }) => {
  await signIn(page);
  await openSettings(page);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Permalinks' }).click();

  await page.getByLabel('Post URL structure').selectOption('/:year/:month/:slug');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Permalinks settings saved.');
  await page.reload();
  await expect(page.getByLabel('Pattern')).toHaveValue('/:year/:month/:slug');

  await page.getByLabel('Post URL structure').selectOption('custom');
  await page.getByLabel('Pattern').fill('/:nope');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('not valid');

  // Put the default back so other tests that rely on /blog/:slug are not affected.
  await page.getByLabel('Post URL structure').selectOption('/blog/:slug');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Permalinks settings saved.');
});
