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

function wxr(title: string, slug: string): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>Old Site</title>
  <link>https://old.example.com</link>
  <wp:base_site_url>https://old.example.com</wp:base_site_url>
  <item>
    <title>${title}</title>
    <link>https://old.example.com/2024/05/${slug}/</link>
    <dc:creator><![CDATA[someone]]></dc:creator>
    <content:encoded><![CDATA[<p>Imported from WordPress.</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>9001</wp:post_id>
    <wp:post_date_gmt><![CDATA[2024-05-01 10:00:00]]></wp:post_date_gmt>
    <wp:post_name><![CDATA[${slug}]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:post_type><![CDATA[post]]></wp:post_type>
  </item>
</channel>
</rss>`;
}

test('import a WordPress export, read the report and follow the old address', async ({ page }) => {
  const tag = Date.now();
  const slug = `imported-${tag}`;
  const title = `Imported ${tag}`;

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Import' })
    .click();
  await expect(page.getByRole('heading', { name: 'Import', level: 1 })).toBeVisible();

  const form = page.getByRole('form', { name: 'WordPress import' });
  const run = form.getByRole('button', { name: 'Run import' });
  await expect(run).toBeDisabled();

  // Something that is not an export is refused before anything is sent.
  await form.getByLabel('WordPress export file').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await expect(form.getByRole('alert')).toContainText('.xml');
  await expect(run).toBeDisabled();

  // A file the server cannot read as an export shows the server's explanation.
  await form.getByLabel('WordPress export file').setInputFiles({
    name: 'broken.xml',
    mimeType: 'text/xml',
    buffer: Buffer.from('this is not xml'),
  });
  await run.click();
  await expect(form.getByRole('alert')).toBeVisible();

  // The real export imports and the report says what happened.
  await form.getByLabel('WordPress export file').setInputFiles({
    name: 'export.xml',
    mimeType: 'text/xml',
    buffer: Buffer.from(wxr(title, slug)),
  });
  await run.click();
  const report = page.getByRole('region', { name: 'Import report' });
  await expect(report).toContainText('Imported 1 post');
  await expect(report).toContainText('1 redirect was saved');

  // The old address answers 301 to the new one, which shows the post.
  const old = await page.request.get(`/2024/05/${slug}`, { maxRedirects: 0 });
  expect(old.status()).toBe(301);
  const target = old.headers()['location'] ?? '';
  expect(target.endsWith(`/${slug}`)).toBe(true);
  await page.goto(target);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
});
