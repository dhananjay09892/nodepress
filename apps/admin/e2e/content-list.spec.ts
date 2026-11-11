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

/** Creates draft items through the API with the browser's own session. */
async function seed(page: Page, type: string, titles: string[]) {
  const me = await page.request.get('/api/v1/auth/me');
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  for (const title of titles) {
    const res = await page.request.post(`/api/v1/content/${type}`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { title, status: 'draft' },
    });
    expect(res.status()).toBe(201);
  }
}

test('list, search, filter and bulk publish and trash posts', async ({ page }) => {
  const tag = `Bulk${Date.now()}`;
  const titles = [`${tag} alpha`, `${tag} beta`, `${tag} gamma`];
  await signIn(page);
  await seed(page, 'post', titles);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Posts' }).click();
  await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible();

  // Search narrows the list to the three new drafts.
  await page.getByLabel('Search', { exact: true }).fill(tag);
  await page.getByRole('button', { name: 'Search' }).click();
  for (const title of titles) {
    await expect(page.getByRole('row', { name: new RegExp(title) })).toBeVisible();
  }
  await expect(page.getByText('Page 1 of 1 (3 items)')).toBeVisible();

  // Bulk publish two of them.
  await page.getByLabel(`Select ${titles[0]}`).check();
  await page.getByLabel(`Select ${titles[1]}`).check();
  await expect(page.getByRole('status')).toHaveText('2 selected');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('2 items published.');
  await expect(page.getByRole('row', { name: new RegExp(titles[0]!) })).toContainText('Published');
  await expect(page.getByRole('row', { name: new RegExp(titles[1]!) })).toContainText('Published');
  await expect(page.getByRole('row', { name: new RegExp(titles[2]!) })).toContainText('Draft');

  // The status filter shows only the remaining draft.
  await page.getByLabel('Status').selectOption('draft');
  await expect(page.getByRole('row', { name: new RegExp(titles[2]!) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(titles[0]!) })).toHaveCount(0);

  // Bulk trash it; it moves to the Trash filter.
  await page.getByLabel(`Select ${titles[2]}`).check();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByRole('status')).toHaveText('1 item moved to the trash.');
  await expect(page.getByText('Nothing found.')).toBeVisible();
  await page.getByLabel('Status').selectOption('trash');
  await expect(page.getByRole('row', { name: new RegExp(titles[2]!) })).toBeVisible();
});

test('the pages screen lists pages', async ({ page }) => {
  const title = `Page${Date.now()}`;
  await signIn(page);
  await seed(page, 'page', [title]);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pages' }).click();
  await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeVisible();
});
