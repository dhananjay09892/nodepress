import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './axe.js';

// Accessibility audit of the admin (N71): axe with the WCAG 2.1 A and AA rules on every screen in
// its main states. Serious and critical violations fail the run.

const EMAIL = 'admin@example.test';
const PASSWORD = 'e2e-test-password-1';
const INSTALL = 'http://localhost:3101';

async function signIn(page: Page) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
}

/** Screens that are reached through the sidebar, with the level-1 heading each one shows. */
const SCREENS: Array<{ path: string; heading: string }> = [
  { path: '/admin/', heading: 'Dashboard' },
  { path: '/admin/posts', heading: 'Posts' },
  { path: '/admin/pages', heading: 'Pages' },
  { path: '/admin/media', heading: 'Media' },
  { path: '/admin/users', heading: 'Users' },
  { path: '/admin/settings', heading: 'Settings' },
  { path: '/admin/settings/reading', heading: 'Settings' },
  { path: '/admin/settings/permalinks', heading: 'Settings' },
  { path: '/admin/menus', heading: 'Menus' },
  { path: '/admin/widgets', heading: 'Widgets' },
  { path: '/admin/plugins', heading: 'Plugins' },
  { path: '/admin/customize', heading: 'Customize' },
  { path: '/admin/redirects', heading: 'Redirects' },
  { path: '/admin/import', heading: 'Import' },
  { path: '/admin/backup', heading: 'Backup' },
  { path: '/admin/messages', heading: 'Messages' },
  { path: '/admin/posts/new', heading: 'Add new post' },
  { path: '/admin/pages/new', heading: 'Add new page' },
  { path: '/admin/editor-preview', heading: 'Editor preview' },
];

test.describe('signed out', () => {
  test('login screen', async ({ page }) => {
    await page.goto('/admin/login');
    await expect(page.getByRole('heading', { name: 'Sign in to NodePress' })).toBeVisible();
    await expectAccessible(page);
  });

  test('login screen with an error', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expectAccessible(page);
  });

  test('web installer', async ({ page }) => {
    await page.goto(`${INSTALL}/install`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  for (const screen of SCREENS) {
    test(`screen ${screen.path}`, async ({ page }) => {
      await page.goto(screen.path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(screen.heading);
      // Let the screen's queries settle so the filled state is what gets audited.
      await page.waitForLoadState('networkidle');
      await expectAccessible(page);
    });
  }

  test('posts list and edit screen with content', async ({ page }) => {
    const title = `A11y post ${Date.now()}`;
    await page.goto('/admin/posts/new');
    await page.getByLabel('Title', { exact: true }).fill(title);
    await page.getByRole('textbox', { name: 'Content' }).click();
    await page.keyboard.type('Text for the accessibility audit');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/admin\/posts\/\d+$/);
    await expect(page.getByRole('heading', { name: 'Edit post' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectAccessible(page);

    await page.goto('/admin/posts');
    await expect(page.getByText(title)).toBeVisible();
    await expectAccessible(page);
  });

  test('new post form with a validation error', async ({ page }) => {
    await page.goto('/admin/posts/new');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.waitForLoadState('networkidle');
    await expectAccessible(page);
  });

  test('redirects form with a field error', async ({ page }) => {
    await page.goto('/admin/redirects');
    const add = page.getByRole('form', { name: 'Add redirect' });
    await add.getByLabel('From').fill('/admin/secret');
    await add.getByLabel('To').fill('/somewhere');
    await add.getByRole('button', { name: 'Add redirect' }).click();
    await expect(add.getByRole('alert')).toBeVisible();
    await expectAccessible(page);
  });

  test('editor with text selected', async ({ page }) => {
    await page.goto('/admin/editor-preview');
    const editor = page.getByRole('textbox', { name: 'Preview content' });
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type('Selected text for the audit');
    await page.keyboard.press('ControlOrMeta+A');
    await page.getByRole('button', { name: 'Bold' }).click();
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectAccessible(page);
  });
});
