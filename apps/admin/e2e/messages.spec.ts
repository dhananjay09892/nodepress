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

test('a message sent from a page with the contact form shows in the admin', async ({ page }) => {
  const tag = Date.now();
  const slug = `contact-${tag}`;
  const text = `Hello from e2e ${tag}`;

  await signIn(page);
  const me = await page.request.get('/api/v1/auth/me');
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const created = await page.request.post('/api/v1/content/page', {
    headers: { 'x-csrf-token': csrfToken },
    data: {
      title: `Contact ${tag}`,
      slug,
      status: 'published',
      body: [{ type: 'core/contact-form' }],
    },
  });
  expect(created.status()).toBe(201);

  // A visitor (no session) fills in the form on the public page.
  const visitor = await page.context().browser()!.newContext({ baseURL: 'http://localhost:3100' });
  const front = await visitor.newPage();
  await front.goto(`/${slug}`);
  await front.getByLabel('Name').fill('Ada Visitor');
  await front.getByLabel('Email').fill('ada@example.test');
  await front.getByLabel('Message').fill(text);
  await front.getByRole('button', { name: /send/i }).click();
  await expect(front.locator('.np-contact-success')).toBeVisible({ timeout: 15_000 });
  await visitor.close();

  // The admin lists it.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Messages' }).click();
  await expect(page.getByRole('heading', { name: 'Messages', level: 1 })).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(text) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Ada Visitor');
  await expect(row).toContainText('ada@example.test');
  await expect(row).toContainText('contact');
});
