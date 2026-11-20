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

test('add a text widget to the sidebar and see it on the front page', async ({ page }) => {
  const tag = Date.now();
  const title = `About ${tag}`;
  const body = `Written in the admin ${tag}`;

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Widgets' })
    .click();
  await expect(page.getByRole('heading', { name: 'Widgets', level: 1 })).toBeVisible();

  const area = page.getByRole('form', { name: 'Sidebar widgets' });
  await area.getByLabel('Widget type').selectOption('text');
  await area.getByRole('button', { name: 'Add widget' }).click();

  // An empty text widget is refused before anything is saved.
  await area.getByRole('button', { name: 'Save Sidebar widgets' }).click();
  await expect(area.getByRole('alert')).toContainText('Text is required');

  const added = area.getByRole('group', { name: /^Arrange Text widget/ }).last();
  await expect(added).toBeVisible();
  await area
    .getByLabel(/^Title of Text widget/)
    .last()
    .fill(title);
  await area
    .getByLabel(/^Text of Text widget/)
    .last()
    .fill(body);
  await area.getByRole('button', { name: 'Save Sidebar widgets' }).click();
  await expect(area.getByRole('status')).toHaveText('Sidebar widgets saved.');

  // It survives a reload and shows on the front page in the sidebar landmark.
  await page.reload();
  await expect(page.getByLabel(/^Title of Text widget/).last()).toHaveValue(title);
  await expect(page.getByLabel(/^Text of Text widget/).last()).toHaveValue(body);
  await page.goto('/');
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(sidebar.getByRole('heading', { name: title })).toBeVisible();
  await expect(sidebar.getByText(body)).toBeVisible();
});
