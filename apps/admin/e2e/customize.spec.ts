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

/** The CSS the front page links for the theme settings ('' when it links none). */
async function frontCss(page: Page): Promise<string> {
  const html = await (await page.request.get('/')).text();
  const href = /href="(\/np\/theme\.css[^"]*)"/.exec(html)?.[1];
  return href ? await (await page.request.get(href)).text() : '';
}

test('change the accent color and see it in the live preview, then save and reset', async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Customize' })
    .click();
  await expect(page.getByRole('heading', { name: 'Customize', level: 1 })).toBeVisible();

  const frame = page.frameLocator('iframe[title="Live preview of the site"]');
  const accentInPreview = () =>
    frame
      .locator('html')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--link').trim().toLowerCase());
  await expect.poll(accentInPreview).toBe('#0b5cad');

  await page.getByLabel('Accent color').fill('#aa0000');
  await expect.poll(accentInPreview).toBe('#aa0000');
  // Nothing is saved yet: the public front page still has the default.
  expect(await frontCss(page)).not.toContain('--link:#aa0000');

  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Customizations saved.');
  await page.reload();
  await expect(page.getByLabel('Accent color')).toHaveValue('#aa0000');
  expect(await frontCss(page)).toContain('--link:#aa0000');
  // The CSS is a stylesheet, not an inline <style> (the default policy blocks those).
  expect(await (await page.request.get('/')).text()).not.toContain('<style');

  // Put the default back so other tests see the stock theme.
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(page.getByRole('status')).toHaveText('Back to the theme defaults.');
  await expect(page.getByLabel('Accent color')).toHaveValue('#0b5cad');
});
