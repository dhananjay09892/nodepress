import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'admin@example.test';
const PASSWORD = 'e2e-test-password-1';

// A valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function openMedia(page: Page) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Media' }).click();
  await expect(page.getByRole('heading', { name: 'Media' })).toBeVisible();
}

test('upload an image, edit its alt text, switch views and delete it', async ({ page }) => {
  const name = `e2e-${Date.now()}`;
  await openMedia(page);

  await page.getByLabel('Upload files').setInputFiles({
    name: `${name}.png`,
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByRole('status')).toHaveText('1 file uploaded.');

  // The new file is selected and its details are shown.
  const details = page.getByRole('complementary', { name: 'File details' });
  await expect(details).toBeVisible();
  await expect(details).toContainText('image/png');
  await expect(page.getByRole('button', { name: new RegExp(`^Select ${name}`) })).toBeVisible();

  // Alt text is saved and becomes the tile's name.
  await details.getByLabel('Alt text').fill('A single pixel');
  await details.getByRole('button', { name: 'Save alt text' }).click();
  await expect(page.getByRole('status')).toHaveText('Alt text saved.');
  await expect(page.getByRole('button', { name: 'Select A single pixel' })).toBeVisible();

  // The list view shows the same file.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('row', { name: /A single pixel/ })).toContainText('image/png');
  await page.getByRole('button', { name: 'Grid', exact: true }).click();

  // Deleting needs a confirmation.
  await details.getByRole('button', { name: 'Delete permanently' }).click();
  await details.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByRole('status')).toHaveText('File deleted.');
  await expect(page.getByRole('button', { name: 'Select A single pixel' })).toHaveCount(0);
  await expect(details).toHaveCount(0);
});

test('a blocked file type is rejected with a reason', async ({ page }) => {
  await openMedia(page);
  await page.getByLabel('Upload files').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await expect(page.getByRole('status')).toHaveText(
    'Could not upload notes.txt (this file type is not allowed).',
  );
});
