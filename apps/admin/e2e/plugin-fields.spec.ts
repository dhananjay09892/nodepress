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

test("a plugin's custom field shows on a post, saves and survives a reload", async ({ page }) => {
  const title = `Fields${Date.now()}`;
  const subtitle = `A subtitle ${Date.now()}`;
  await signIn(page);

  await page.goto('/admin/posts/new');
  await expect(page.getByRole('heading', { name: 'Custom fields' })).toBeVisible();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Subtitle').fill(subtitle);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/admin\/posts\/\d+$/);
  const id = /\/admin\/posts\/(\d+)$/.exec(page.url())![1];

  await page.reload();
  await expect(page.getByLabel('Subtitle')).toHaveValue(subtitle);

  // Change it and save: only the field that changed goes to the server.
  const changed = `${subtitle} changed`;
  await page.getByLabel('Subtitle').fill(changed);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved at' })).toBeVisible();

  const res = await page.request.get(`/api/v1/content/post/${id}`);
  const item = ((await res.json()) as { item: { meta: Record<string, unknown> } }).item;
  expect(item.meta['subtitle']).toBe(changed);

  // Pages do not get the post-only field.
  await page.goto('/admin/pages/new');
  await expect(page.getByRole('heading', { name: 'Add new page' })).toBeVisible();
  await expect(page.getByLabel('Subtitle')).toHaveCount(0);
});
