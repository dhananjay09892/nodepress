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

test('a plugin adds a menu item and a settings page that saves', async ({ page }) => {
  const line = `Until next time ${Date.now()}`;
  await signIn(page);

  // The example plugin adds "Hello" to the sidebar.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Hello' }).click();
  await expect(page.getByRole('heading', { name: 'Hello settings', level: 1 })).toBeVisible();

  const save = page.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeDisabled();
  await expect(page.getByLabel('Closing line')).toHaveValue('Thanks for reading!');

  await page.getByLabel('Closing line').fill(line);
  await save.click();
  await expect(page.getByRole('status')).toHaveText('Closing line saved.');

  await page.reload();
  await expect(page.getByLabel('Closing line')).toHaveValue(line);

  // The saved value reaches the site itself.
  const home = await page.request.get('/');
  expect(await home.text()).toContain(line);
});

test('a page that does not exist says so', async ({ page }) => {
  await signIn(page);
  await page.goto('/admin/extensions/hello-nodepress/nope');
  await expect(page.getByText('This page is not available.')).toBeVisible();
});
