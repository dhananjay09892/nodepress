import { expect, test, type Page } from '@playwright/test';
import { createTestZip } from './zip.js';

// One owner's first hour on a brand new site (the empty server on port 3101, see
// playwright.config.ts): install, sign in, write and publish a post, see it on the site, add a
// plugin, and change the theme. The other specs cover each screen in depth on the main site.
const SITE = 'http://localhost:3101';
const EMAIL = 'owner@example.test';
const PASSWORD = 'a-long-setup-password';
const SETUP_CODE = 'e2e-setup-code';

test.describe.configure({ mode: 'serial' });

async function ensureInstalled(page: Page) {
  const status = await page.request.get(`${SITE}/api/v1/install/status`);
  const { needsSetup } = (await status.json()) as { needsSetup: boolean };
  if (!needsSetup) return;
  // The wizard itself is covered by install.spec.ts; here the API finishes the setup.
  const res = await page.request.post(`${SITE}/api/v1/install`, {
    data: { code: SETUP_CODE, siteName: 'Journey Site', email: EMAIL, password: PASSWORD },
  });
  expect(res.status()).toBe(201);
}

async function signIn(page: Page) {
  await page.goto(`${SITE}/admin/login`);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${SITE}/admin/`);
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();

test('install, write and publish a post, add a plugin and change the theme', async ({ page }) => {
  const title = `Journey ${Date.now()}`;
  const plugin = `journey-notes-${Date.now()}`;

  // 1. Install: a fresh site is a wizard until it has an administrator.
  await ensureInstalled(page);
  await page.goto(`${SITE}/`);
  await expect(page).not.toHaveURL(/\/install/);

  // 2. Sign in and write a post.
  await signIn(page);
  await nav(page, 'Posts');
  await page.getByRole('link', { name: 'Add new post' }).click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'Content' }).click();
  await page.keyboard.type('Written on the first day.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/admin\/posts\/\d+$/);
  const id = Number(/\/posts\/(\d+)$/.exec(page.url())![1]);
  const slug = await page.getByLabel('Slug').inputValue();
  expect(slug).not.toBe('');

  // A draft is not on the site.
  expect((await page.request.get(`${SITE}/blog/${slug}`)).status()).toBe(404);

  // 3. Publish it and read it on the public site.
  await page.getByLabel('Status').selectOption('published');
  await page.getByRole('button', { name: 'Update' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved at' })).toBeVisible();
  const item = await page.request.get(`${SITE}/api/v1/content/post/${id}`);
  expect(((await item.json()) as { item: { status: string } }).item.status).toBe('published');
  const live = await page.request.get(`${SITE}/blog/${slug}`);
  expect(live.status()).toBe(200);
  const html = await live.text();
  expect(html).toContain(title);
  expect(html).toContain('Written on the first day.');
  expect(html).toContain('Journey Site');

  // 4. Add a plugin: upload, review the permissions, enable.
  const zip = createTestZip([
    {
      name: 'plugin.json',
      data: JSON.stringify({
        name: plugin,
        version: '1.0.0',
        title: `Journey Notes ${plugin}`,
        description: 'Added during the end-to-end journey',
        permissions: ['content:read'],
      }),
    },
    { name: 'index.js', data: `export default { name: '${plugin}', setup() {} };\n` },
  ]);
  await nav(page, 'Plugins');
  await page
    .getByRole('form', { name: 'Upload a plugin' })
    .getByLabel('Plugin package (.zip)')
    .setInputFiles({
      name: `${plugin}.zip`,
      mimeType: 'application/zip',
      buffer: Buffer.from(zip),
    });
  await page.getByRole('button', { name: 'Upload plugin' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Plugin uploaded. It is off until you enable it.',
  );
  const card = page.getByRole('article', { name: new RegExp(plugin) });
  await card.getByRole('button', { name: /^Enable / }).click();
  await card
    .getByRole('group', { name: /^Enable .*\?$/ })
    .getByRole('button', { name: 'Enable plugin' })
    .click();
  await expect(card.getByText('On after restart')).toBeVisible();

  // 5. Change the theme's look and see it on the public site.
  await nav(page, 'Customize');
  await page.getByLabel('Accent color').fill('#118844');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Customizations saved.');
  expect(await (await page.request.get(`${SITE}/`)).text()).toContain('--link:#118844');
  // The post is still there, now in the new colors.
  expect(await (await page.request.get(`${SITE}/blog/${slug}`)).text()).toContain('--link:#118844');
});
