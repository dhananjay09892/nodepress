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

/** Creates a user through the API with the browser's own session. */
async function seedUser(page: Page, email: string, displayName: string, role: string) {
  const me = await page.request.get('/api/v1/auth/me');
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const res = await page.request.post('/api/v1/users', {
    headers: { 'x-csrf-token': csrfToken },
    data: { email, password: PASSWORD, displayName, role },
  });
  expect(res.status()).toBe(201);
}

async function openUsers(page: Page) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
}

test('search for a user, change their role and see it in the list', async ({ page }) => {
  const tag = `role${Date.now()}`;
  const email = `${tag}@example.test`;
  await signIn(page);
  await seedUser(page, email, `Writer ${tag}`, 'author');
  await openUsers(page);

  await page.getByLabel('Search users').fill(tag);
  const row = page.getByRole('row', { name: new RegExp(tag) });
  await expect(row).toContainText('Author');
  await expect(page.getByRole('row', { name: new RegExp(EMAIL) })).toHaveCount(0);

  await page.getByRole('button', { name: `Edit Writer ${tag}` }).click();
  const panel = page.getByRole('complementary', { name: 'Edit user' });
  await expect(panel.getByLabel('Email')).toHaveValue(email);
  await expect(panel.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  await panel.getByLabel('Role').selectOption('editor');
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText(`Saved Writer ${tag}.`);
  await expect(row).toContainText('Editor');

  // The role filter finds the same person.
  await page.getByLabel('Search users').fill('');
  await page.getByLabel('Filter by role').selectOption('editor');
  await expect(page.getByRole('row', { name: new RegExp(tag) })).toBeVisible();
});

test('a taken email address is refused with a reason', async ({ page }) => {
  const tag = `dup${Date.now()}`;
  await signIn(page);
  await seedUser(page, `${tag}@example.test`, `Dup ${tag}`, 'subscriber');
  await openUsers(page);

  await page.getByLabel('Search users').fill(tag);
  await page.getByRole('button', { name: `Edit Dup ${tag}` }).click();
  const panel = page.getByRole('complementary', { name: 'Edit user' });
  await panel.getByLabel('Email').fill(EMAIL);
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByRole('alert')).toHaveText('Another user already has that email address.');
});

test('you cannot change your own role', async ({ page }) => {
  await signIn(page);
  await openUsers(page);
  await page.getByLabel('Search users').fill(EMAIL);
  await page.getByRole('button', { name: 'Edit Administrator' }).click();
  const panel = page.getByRole('complementary', { name: 'Edit user' });
  await expect(panel.getByLabel('Role')).toBeDisabled();
  await expect(panel).toContainText('You cannot change your own role.');
});
