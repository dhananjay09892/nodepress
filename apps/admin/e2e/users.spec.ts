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

test('add a user, set a new password and delete them', async ({ page }) => {
  const tag = `new${Date.now()}`;
  const email = `${tag}@example.test`;
  await signIn(page);
  await openUsers(page);

  await page.getByRole('button', { name: 'Add user' }).click();
  const add = page.getByRole('complementary', { name: 'Add user' });
  await add.getByLabel('Display name').fill(`Added ${tag}`);
  await add.getByLabel('Email').fill(email);
  await add.getByLabel('Password').fill(PASSWORD);
  await add.getByLabel('Role').selectOption('editor');
  await add.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByRole('status')).toHaveText(`Added Added ${tag}.`);

  await page.getByLabel('Search users').fill(tag);
  await expect(page.getByRole('row', { name: new RegExp(tag) })).toContainText('Editor');

  await page.getByRole('button', { name: `Edit Added ${tag}` }).click();
  const panel = page.getByRole('complementary', { name: 'Edit user' });
  await panel.getByLabel('New password').fill('another-e2e-password-2');
  await panel.getByRole('button', { name: 'Set password' }).click();
  await expect(panel.getByRole('status')).toHaveText(`Password changed for Added ${tag}.`);

  await panel.getByRole('button', { name: 'Delete user' }).click();
  const dialog = panel.getByRole('alertdialog');
  await expect(dialog).toContainText(`Delete Added ${tag}?`);
  await dialog.getByRole('button', { name: 'Confirm delete' }).click();
  // The page status comes first; the panel's own password status may still be on screen.
  await expect(page.getByRole('status').first()).toHaveText(`Deleted Added ${tag}.`);
  await expect(page.getByRole('row', { name: new RegExp(tag) })).toHaveCount(0);
});

test('a bad new user is explained, and you cannot delete yourself', async ({ page }) => {
  await signIn(page);
  await openUsers(page);
  await page.getByRole('button', { name: 'Add user' }).click();
  const add = page.getByRole('complementary', { name: 'Add user' });
  await add.getByLabel('Email').fill('not-an-email');
  await add.getByRole('button', { name: 'Create user' }).click();
  await expect(add.getByRole('alert')).toHaveText('Enter a valid email address.');
  await add.getByRole('button', { name: 'Close' }).click();

  await page.getByLabel('Search users').fill(EMAIL);
  await page.getByRole('button', { name: 'Edit Administrator' }).click();
  const panel = page.getByRole('complementary', { name: 'Edit user' });
  await expect(panel.getByRole('button', { name: 'Delete user' })).toHaveCount(0);
});
