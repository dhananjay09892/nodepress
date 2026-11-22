import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'admin@example.test';
const PASSWORD = 'e2e-test-password-1';

/** Records every Content-Security-Policy violation the browser reports on this page. */
function watchViolations(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/content security policy|refused to (apply|load|execute)/i.test(text)) seen.push(text);
  });
  return seen;
}

async function signIn(page: Page) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
}

test('the default policy has no unsafe-inline and the admin runs without violations', async ({
  page,
}) => {
  const violations = watchViolations(page);
  const res = await page.goto('/admin/login');
  for (const header of ['content-security-policy']) {
    const policy = res?.headers()[header] ?? '';
    expect(policy).toContain("style-src 'self'");
    expect(policy).not.toContain('unsafe-inline');
  }
  const front = await page.request.get('/');
  const policy = front.headers()['content-security-policy'] ?? '';
  expect(policy).toContain("style-src 'self';");
  expect(policy).not.toContain('unsafe-inline');

  await signIn(page);
  const links = await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link')
    .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute('href') ?? ''));
  expect(links.length).toBeGreaterThan(5);
  for (const href of links.filter((h) => h.startsWith('/admin'))) {
    await page.goto(href);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
  }

  // The editor (Tiptap/ProseMirror) and the customizer frame are the likeliest to need inline styles.
  await page.goto('/admin/posts/new');
  await expect(page.getByRole('textbox', { name: 'Content' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Content' }).click();
  await page.keyboard.type('Typing under a strict policy');
  await page.goto('/admin/customize');
  await expect(page.getByRole('heading', { name: 'Customize', level: 1 })).toBeVisible();
  await page.frameLocator('iframe[title="Live preview of the site"]').locator('body').waitFor();
  await page.waitForLoadState('networkidle');

  expect(violations).toEqual([]);
});

test('the public front page and the contact form run without violations', async ({ page }) => {
  const violations = watchViolations(page);
  await signIn(page);
  const me = await page.request.get('/api/v1/auth/me');
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const slug = `csp-${Date.now()}`;
  const created = await page.request.post('/api/v1/content/page', {
    headers: { 'x-csrf-token': csrfToken },
    data: { title: 'CSP', slug, status: 'published', body: [{ type: 'core/contact-form' }] },
  });
  expect(created.status()).toBe(201);

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.goto(`/${slug}`);
  await expect(page.getByLabel('Name')).toBeVisible();
  await page.waitForLoadState('networkidle');
  // The honeypot is moved off screen by the script (CSSOM is allowed), not by markup.
  const trap = page.locator('.np-field-trap');
  await expect(trap).not.toHaveAttribute('hidden', /.*/);
  expect(await trap.evaluate((el) => (el as HTMLElement).style.left)).toBe('-10000px');

  expect(violations).toEqual([]);
});

test('the web installer runs without violations', async ({ page }) => {
  const violations = watchViolations(page);
  await page.goto('http://localhost:3101/install');
  await expect(page.getByRole('heading', { name: 'Set up NodePress' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(violations).toEqual([]);
});
