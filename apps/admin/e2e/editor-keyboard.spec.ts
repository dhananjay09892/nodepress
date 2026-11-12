import { expect, test } from '@playwright/test';

const EMAIL = 'admin@example.test';
const PASSWORD = 'e2e-test-password-1';

test('the editor toolbar can be used with the keyboard alone', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/$/);

  await page.goto('/admin/editor-preview');
  const editor = page.getByRole('textbox', { name: 'Preview content' });
  await expect(editor).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();

  // Start in the editing area, then walk back through the toolbar with Shift+Tab only.
  await editor.focus();
  const focusedName = () =>
    page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
  let name = await focusedName();
  for (let i = 0; i < 40 && name !== 'Heading 2'; i += 1) {
    await page.keyboard.press('Shift+Tab');
    name = await focusedName();
  }
  expect(name).toBe('Heading 2');

  // Activate with Space, as a keyboard user would.
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Heading 2' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // The editor takes focus back through the same chain of Tab presses and typing works.
  await editor.focus();
  await page.keyboard.type('Keyboard only');
  const json = page.getByTestId('block-json');
  await expect(json).toContainText('"type": "core/heading"');
  await expect(json).toContainText('Keyboard only');
});
