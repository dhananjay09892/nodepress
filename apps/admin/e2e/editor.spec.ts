import { expect, test } from '@playwright/test';

const EMAIL = 'admin@example.test';
const PASSWORD = 'e2e-test-password-1';

test('the block editor turns typing and formatting into block JSON', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/$/);

  await page.goto('/admin/editor-preview');
  await expect(page.getByRole('heading', { name: 'Editor preview' })).toBeVisible();

  await page.getByRole('button', { name: 'Heading 2' }).click();
  const editor = page.getByRole('textbox', { name: 'Preview content' });
  await editor.click();
  await page.keyboard.type('Hello blocks');

  const json = page.getByTestId('block-json');
  await expect(json).toContainText('"type": "core/heading"');
  await expect(json).toContainText('"level": 2');
  await expect(json).toContainText('Hello blocks');

  await page.keyboard.press('Enter');
  await page.keyboard.type('Second paragraph');
  await expect(json).toContainText('"type": "core/paragraph"');
  await expect(json).toContainText('Second paragraph');
});
