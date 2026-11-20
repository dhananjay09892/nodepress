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

test('download a backup, refuse a wrong file and restore the backup', async ({ page }) => {
  const title = `Backup${Date.now()}`;
  const from = `/${title.toLowerCase()}-old`;

  // One published post and one redirect to back up.
  await signIn(page);
  const me = await page.request.get('/api/v1/auth/me');
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const post = await page.request.post('/api/v1/content/post', {
    headers: { 'x-csrf-token': csrfToken },
    data: { title, status: 'published' },
  });
  expect(post.status()).toBe(201);
  const rule = await page.request.post('/api/v1/redirects', {
    headers: { 'x-csrf-token': csrfToken },
    data: { from, to: '/' },
  });
  expect(rule.status()).toBe(201);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Backup' }).click();
  await expect(page.getByRole('heading', { name: 'Backup', level: 1 })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download backup' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^nodepress-export-\d{4}-\d{2}-\d{2}\.json$/);
  const file = await download.path();
  expect(file).toBeTruthy();

  // A wrong file is refused before anything is sent.
  const form = page.getByRole('form', { name: 'Restore a backup' });
  await form.getByLabel('Backup file').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await expect(page.getByRole('alert')).toContainText('.json');
  await expect(form.getByRole('button', { name: 'Restore backup' })).toBeDisabled();

  // Restoring adds the content next to what is there: the post now exists twice, and the
  // redirect that already exists is reported, not duplicated.
  await form.getByLabel('Backup file').setInputFiles(file!);
  await form.getByRole('button', { name: 'Restore backup' }).click();
  const result = page.getByRole('region', { name: 'Restore result' });
  await expect(result).toContainText('Restored');
  await expect(result).toContainText(`Redirect from "${from}" skipped`);

  const list = await page.request.get(`/api/v1/content/post?q=${title}`);
  const items = ((await list.json()) as { items: Array<{ title: string }> }).items;
  expect(items.filter((item) => item.title === title)).toHaveLength(2);
  const rules = await (await page.request.get('/api/v1/redirects')).json();
  expect(JSON.stringify(rules).split(from).length - 1).toBe(1);
});
