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

test('add a redirect, import a CSV and see both work on the site', async ({ page }) => {
  const tag = Date.now();
  const oldPath = `/old-${tag}`;
  const newPath = `/new-${tag}`;
  const csvOld = `/csv-old-${tag}`;
  const csvNew = `/csv-new-${tag}`;

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Redirects' })
    .click();
  await expect(page.getByRole('heading', { name: 'Redirects', level: 1 })).toBeVisible();

  // A path the system owns is refused, with the message next to the field.
  const add = page.getByRole('form', { name: 'Add redirect' });
  await add.getByLabel('From').fill('/admin/secret');
  await add.getByLabel('To').fill(newPath);
  await add.getByRole('button', { name: 'Add redirect' }).click();
  await expect(add.getByRole('alert')).toBeVisible();

  // A valid rule is saved and shows in the table.
  await add.getByLabel('From').fill(oldPath);
  await add.getByRole('button', { name: 'Add redirect' }).click();
  await expect(page.getByRole('cell', { name: oldPath, exact: true })).toBeVisible();

  // The old address now answers with a permanent redirect.
  const first = await page.request.get(oldPath, { maxRedirects: 0 });
  expect(first.status()).toBe(301);
  expect(first.headers()['location']).toBe(newPath);

  // Edit it to a temporary redirect.
  await page.getByRole('button', { name: `Edit redirect from ${oldPath}` }).click();
  const edit = page.getByRole('form', { name: `Edit redirect from ${oldPath}` });
  await edit.getByLabel('Type').selectOption('302');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: '302', exact: true }).first()).toBeVisible();
  expect((await page.request.get(oldPath, { maxRedirects: 0 })).status()).toBe(302);

  // Import a CSV with one good row and one refused row.
  await page.getByLabel('CSV file').setInputFiles({
    name: 'redirects.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`from,to,status\n${csvOld},${csvNew},301\n/api/v1/nope,${csvNew},301\n`),
  });
  const result = page.getByRole('status');
  await expect(result).toContainText('1 created');
  await expect(result).toContainText('1 refused');
  await expect(result).toContainText('Line 3');
  const imported = await page.request.get(csvOld, { maxRedirects: 0 });
  expect(imported.status()).toBe(301);
  expect(imported.headers()['location']).toBe(csvNew);

  // Delete the first rule; its address is a plain 404 again.
  await page.getByRole('button', { name: `Delete redirect from ${oldPath}` }).click();
  await expect(page.getByRole('cell', { name: oldPath, exact: true })).toHaveCount(0);
  expect((await page.request.get(oldPath, { maxRedirects: 0 })).status()).toBe(404);
});
