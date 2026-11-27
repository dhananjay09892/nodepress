import { expect, test } from '@playwright/test';
import { expectNoSeriousViolations, signIn } from './a11y.js';

// Every admin screen in its main states, checked with axe against WCAG 2.1 A and AA.
// Serious and critical violations fail the test; the rest are printed (see docs/accessibility.md).

const SCREENS: { name: string; path: string; heading: RegExp | string }[] = [
  { name: 'dashboard', path: '/admin/', heading: 'Dashboard' },
  { name: 'posts list', path: '/admin/posts', heading: 'Posts' },
  { name: 'pages list', path: '/admin/pages', heading: 'Pages' },
  { name: 'media library', path: '/admin/media', heading: 'Media' },
  { name: 'users', path: '/admin/users', heading: 'Users' },
  { name: 'general settings', path: '/admin/settings', heading: 'Settings' },
  { name: 'reading settings', path: '/admin/settings/reading', heading: 'Settings' },
  { name: 'permalink settings', path: '/admin/settings/permalinks', heading: 'Settings' },
  { name: 'menus', path: '/admin/menus', heading: 'Menus' },
  { name: 'widgets', path: '/admin/widgets', heading: 'Widgets' },
  { name: 'customize', path: '/admin/customize', heading: 'Customize' },
  { name: 'plugins', path: '/admin/plugins', heading: 'Plugins' },
  { name: 'redirects', path: '/admin/redirects', heading: 'Redirects' },
  { name: 'messages', path: '/admin/messages', heading: 'Messages' },
  { name: 'import', path: '/admin/import', heading: 'Import' },
  { name: 'backup', path: '/admin/backup', heading: 'Backup' },
  { name: 'new post', path: '/admin/posts/new', heading: 'Add new post' },
  { name: 'editor preview', path: '/admin/editor-preview', heading: 'Editor preview' },
];

test.describe('accessibility (axe, WCAG 2.1 A and AA)', () => {
  test('login screen, empty and with an error', async ({ page }) => {
    await page.goto('/admin/login');
    await expect(page.getByRole('heading', { name: 'Sign in to NodePress' })).toBeVisible();
    await expectNoSeriousViolations(page, 'login (empty)');

    await page.getByLabel('Email').fill('admin@example.test');
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expectNoSeriousViolations(page, 'login (error)');
  });

  for (const screen of SCREENS) {
    test(`${screen.name} screen`, async ({ page }) => {
      await signIn(page);
      await page.goto(screen.path);
      await expect(page.getByRole('heading', { name: screen.heading }).first()).toBeVisible();
      // Let data loads settle so loading and loaded states are not mixed up.
      await page.waitForLoadState('networkidle');
      const rest = await expectNoSeriousViolations(page, screen.name);
      for (const v of rest) console.log(`[a11y ${screen.name}] ${v.impact} ${v.id}: ${v.help}`);
    });
  }

  test('redirects: filled list and a form with an error', async ({ page }) => {
    const tag = Date.now();
    await signIn(page);
    await page.goto('/admin/redirects');
    const add = page.getByRole('form', { name: 'Add redirect' });
    await add.getByLabel('From').fill('/admin/secret');
    await add.getByLabel('To').fill(`/new-${tag}`);
    await add.getByRole('button', { name: 'Add redirect' }).click();
    await expect(add.getByRole('alert')).toBeVisible();
    await expectNoSeriousViolations(page, 'redirects (form error)');

    await add.getByLabel('From').fill(`/old-${tag}`);
    await add.getByRole('button', { name: 'Add redirect' }).click();
    await expect(page.getByRole('cell', { name: `/old-${tag}`, exact: true })).toBeVisible();
    await expectNoSeriousViolations(page, 'redirects (filled list)');
  });
});
