import { expect, test, type Page } from '@playwright/test';
import { createTestZip } from './zip.js';

const EMAIL = 'admin@example.test';
const PASSWORD = 'e2e-test-password-1';

async function signIn(page: Page) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
}

test('upload a plugin, review its permissions, enable it, then disable it', async ({ page }) => {
  const name = `e2e-notes-${Date.now()}`;
  const title = `E2E Notes ${Date.now()}`;
  const zip = createTestZip([
    {
      name: 'plugin.json',
      data: JSON.stringify({
        name,
        version: '1.2.0',
        title,
        description: 'Sticky notes for the e2e test',
        permissions: ['content:read', 'network'],
      }),
    },
    { name: 'index.js', data: `export default { name: '${name}', setup() {} };\n` },
  ]);

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Plugins' })
    .click();
  await expect(page.getByRole('heading', { name: 'Plugins', level: 1 })).toBeVisible();

  // Not a zip: refused with a reason, nothing installed.
  const form = page.getByRole('form', { name: 'Upload a plugin' });
  await form.getByLabel('Plugin package (.zip)').setInputFiles({
    name: 'bad.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('this is not a zip file, just some text'),
  });
  await form.getByRole('button', { name: 'Upload plugin' }).click();
  await expect(page.getByRole('alert')).toContainText('not a usable zip');

  await form.getByLabel('Plugin package (.zip)').setInputFiles({
    name: `${name}.zip`,
    mimeType: 'application/zip',
    buffer: Buffer.from(zip),
  });
  await form.getByRole('button', { name: 'Upload plugin' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Plugin uploaded. It is off until you enable it.',
  );

  // It is listed, off, with the permissions it declares.
  const card = page.getByRole('article', { name: new RegExp(title) });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Sticky notes for the e2e test');
  await expect(card).toContainText('Read posts and pages');
  await expect(card).toContainText('Connect to other websites');
  await expect(card.getByText('Off', { exact: true })).toBeVisible();

  // Enabling asks first, showing the permissions again; cancelling changes nothing.
  await card.getByRole('button', { name: `Enable ${title}` }).click();
  const confirm = card.getByRole('group', { name: `Enable ${title}?` });
  await expect(confirm).toContainText('Connect to other websites');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.getByText('Off', { exact: true })).toBeVisible();

  await card.getByRole('button', { name: `Enable ${title}` }).click();
  await card
    .getByRole('group', { name: `Enable ${title}?` })
    .getByRole('button', { name: 'Enable plugin' })
    .click();
  await expect(page.getByRole('status')).toHaveText(`${title} enabled.`);
  await expect(card.getByText('On after restart')).toBeVisible();
  await expect(page.getByRole('note')).toContainText('Restart the site');

  // The choice is stored: it survives a reload.
  await page.reload();
  const again = page.getByRole('article', { name: new RegExp(title) });
  await expect(again.getByText('On after restart')).toBeVisible();

  await again.getByRole('button', { name: `Disable ${title}` }).click();
  await expect(page.getByRole('status')).toHaveText(`${title} disabled.`);
  await expect(again.getByText('Off', { exact: true })).toBeVisible();

  // Uploading the same package again is refused.
  await page
    .getByRole('form', { name: 'Upload a plugin' })
    .getByLabel('Plugin package (.zip)')
    .setInputFiles({
      name: `${name}.zip`,
      mimeType: 'application/zip',
      buffer: Buffer.from(zip),
    });
  await page.getByRole('button', { name: 'Upload plugin' }).click();
  await expect(page.getByRole('alert')).toContainText('already installed');
});
