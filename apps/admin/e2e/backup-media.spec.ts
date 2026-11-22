import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'admin@example.test';
const PASSWORD = 'e2e-test-password-1';

// A valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function signIn(page: Page) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
}

async function withAlt(page: Page, alt: string): Promise<number> {
  const res = await page.request.get('/api/v1/media?limit=200');
  const body = (await res.json()) as { media: Array<{ alt: string }> };
  return body.media.filter((m) => m.alt === alt).length;
}

test('download the media zip and restore it', async ({ page }) => {
  const alt = `Backup pixel ${Date.now()}`;
  await signIn(page);
  const me = await page.request.get('/api/v1/auth/me');
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const upload = await page.request.post('/api/v1/media', {
    headers: { 'x-csrf-token': csrfToken },
    multipart: { file: { name: 'pixel.png', mimeType: 'image/png', buffer: PNG }, alt },
  });
  expect(upload.status()).toBe(201);
  expect(await withAlt(page, alt)).toBe(1);

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Backup' })
    .click();
  await expect(page.getByRole('heading', { name: 'Backup', level: 1 })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.getByRole('link', { name: 'Download media zip' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^nodepress-media-\d{4}-\d{2}-\d{2}\.zip$/);
  const file = path.join(os.tmpdir(), download.suggestedFilename());
  await download.saveAs(file);

  // A file that is not a zip is refused before anything is sent.
  const form = page.getByRole('form', { name: 'Restore media' });
  await form.getByLabel('Media zip').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await expect(form.getByRole('alert')).toContainText('.zip');
  await expect(form.getByRole('button', { name: 'Restore media' })).toBeDisabled();

  // Restoring adds the files next to the existing ones: the picture now exists twice.
  await form.getByLabel('Media zip').setInputFiles(file);
  await form.getByRole('button', { name: 'Restore media' }).click();
  await expect(page.getByRole('status', { name: 'Media restore result' })).toContainText(
    'Restored',
    { timeout: 60_000 },
  );
  expect(await withAlt(page, alt)).toBe(2);
});
