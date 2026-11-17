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

// Exact, so the "Show the closing line" checkbox and the panel form do not match too.
const closingLine = (page: Page) => page.getByLabel('Closing line', { exact: true });

test('a plugin adds a menu item and a settings page that saves', async ({ page }) => {
  const line = `Until next time ${Date.now()}`;
  await signIn(page);

  // The example plugin adds "Hello" to the sidebar.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Hello' }).click();
  await expect(page.getByRole('heading', { name: 'Hello settings', level: 1 })).toBeVisible();

  const save = page.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeDisabled();
  await expect(closingLine(page)).toHaveValue('Thanks for reading!');

  await closingLine(page).fill(line);
  await save.click();
  await expect(page.getByRole('status')).toHaveText('Closing saved.');

  await page.reload();
  await expect(closingLine(page)).toHaveValue(line);

  // The saved value reaches the site itself.
  const home = await page.request.get('/');
  expect(await home.text()).toContain(line);
});

test('a page that does not exist says so', async ({ page }) => {
  await signIn(page);
  await page.goto('/admin/extensions/hello-nodepress/nope');
  await expect(page.getByText('This page is not available.')).toBeVisible();
});
