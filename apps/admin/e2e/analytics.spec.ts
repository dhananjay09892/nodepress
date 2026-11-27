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

test('a page visited twice shows its two views on the Analytics screen', async ({ page }) => {
  const tag = Date.now();
  const slug = `analytics-${tag}`;

  await signIn(page);
  const me = await page.request.get('/api/v1/auth/me');
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const created = await page.request.post('/api/v1/content/page', {
    headers: { 'x-csrf-token': csrfToken },
    data: {
      title: `Analytics ${tag}`,
      slug,
      status: 'published',
      body: [{ type: 'paragraph', text: 'Counted.' }],
    },
  });
  expect(created.status()).toBe(201);

  // A visitor (no session) opens the page twice; the script sends one beacon per visit.
  const visitor = await page.context().browser()!.newContext({ baseURL: 'http://localhost:3100' });
  const front = await visitor.newPage();
  for (let visit = 0; visit < 2; visit++) {
    const beacon = front.waitForResponse(
      (res) => res.url().includes('/api/v1/plugins/analytics/hit') && res.status() === 204,
    );
    await front.goto(`/${slug}`);
    await beacon;
  }
  await visitor.close();

  await page.goto('/admin/');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Analytics', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Showing');

  // Top pages lists the page with its two views.
  const topPages = page.getByRole('table', { name: 'Top pages' });
  await expect(topPages.getByRole('row', { name: new RegExp(`/${slug}.*2`) })).toBeVisible();

  // The chart has a table with the same numbers: today has at least these two views.
  await page.getByText(/as a table/).click();
  const perDay = page.getByRole('table', { name: 'Per day' });
  await expect(perDay.getByRole('row').last()).toContainText(new Date().toISOString().slice(0, 10));

  // A range in the future is refused before anything is requested.
  await page.getByLabel('To', { exact: true }).fill('2999-01-01');
  await expect(page.getByRole('alert')).toHaveText('The end date cannot be in the future.');
  await expect(page.getByRole('button', { name: 'Show' })).toBeDisabled();

  // A quick range works again.
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(topPages.getByRole('row', { name: new RegExp(`/${slug}.*2`) })).toBeVisible();
});

test('the retention page is still reachable from the sidebar', async ({ page }) => {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Analytics retention' })
    .click();
  await expect(page.getByLabel('Keep data for (days)')).toBeVisible();
});
