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

async function addLink(page: Page, label: string, url: string) {
  await page.getByLabel('Link label').fill(label);
  await page.getByLabel('Link address').fill(url);
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.getByRole('group', { name: `Arrange ${label}` })).toBeVisible();
}

test('create a menu with a nested link, assign it to a location and see it on the front page', async ({
  page,
}) => {
  const tag = Date.now();
  const menuName = `Header ${tag}`;
  const parent = `Company${tag}`;
  const child = `Team${tag}`;

  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Menus' }).click();
  await expect(page.getByRole('heading', { name: 'Menus', level: 1 })).toBeVisible();

  await page.getByLabel('New menu name').fill(menuName);
  await page.getByRole('button', { name: 'Create menu' }).click();
  await expect(page.getByLabel('Menu name', { exact: true })).toHaveValue(menuName);

  await addLink(page, parent, '/company');
  await addLink(page, child, '/company/team');
  // Keyboard-operable arranging: the second link goes under the first.
  await page.getByRole('button', { name: `Indent ${child} under the link above` }).click();
  await expect(page.getByRole('button', { name: `Outdent ${child}` })).toBeEnabled();
  await expect(page.getByRole('button', { name: `Move ${parent} up` })).toBeDisabled();

  // A bad address is refused before anything is saved.
  await page.getByLabel('Link label').fill('Bad');
  await page.getByLabel('Link address').fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.getByRole('alert')).toContainText('address must be');

  await page.getByRole('button', { name: 'Save menu' }).click();
  await expect(page.getByRole('status')).toHaveText('Menu saved.');

  await page.getByLabel('Primary menu').selectOption({ label: menuName });
  await page.getByRole('button', { name: 'Save locations' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Locations saved.' })).toBeVisible();

  // The nesting survives a reload of the editor.
  await page.reload();
  await expect(page.getByLabel('Menu to edit')).toContainText(menuName);

  await page.goto('/');
  const primary = page.getByRole('navigation', { name: 'Primary' });
  await expect(primary.getByRole('link', { name: parent })).toBeVisible();
  await expect(primary.locator('ul ul').getByRole('link', { name: child })).toBeVisible();
});

test('a menu can be deleted after confirming', async ({ page }) => {
  const menuName = `Temporary ${Date.now()}`;
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Menus' }).click();
  await page.getByLabel('New menu name').fill(menuName);
  await page.getByRole('button', { name: 'Create menu' }).click();
  await expect(page.getByLabel('Menu name', { exact: true })).toHaveValue(menuName);

  await page.getByRole('button', { name: 'Delete menu' }).click();
  await page.getByRole('button', { name: 'Yes, delete menu' }).click();
  await expect(page.getByRole('option', { name: menuName })).toHaveCount(0);
});
