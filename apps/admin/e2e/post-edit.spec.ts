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

function idFromUrl(page: Page): number {
  const match = /\/admin\/posts\/(\d+)$/.exec(page.url());
  expect(match).not.toBeNull();
  return Number(match![1]);
}

test('write a post, publish it, change it and restore an earlier version', async ({ page }) => {
  const title = `Edit${Date.now()}`;
  await signIn(page);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Posts' }).click();
  await page.getByRole('link', { name: 'Add new post' }).click();
  await expect(page.getByRole('heading', { name: 'Add new post' })).toBeVisible();

  await page.getByLabel('Title').fill(title);
  await page.getByRole('textbox', { name: 'Content' }).click();
  await page.keyboard.type('First version of the text');
  await page.getByRole('button', { name: 'Save draft' }).click();

  // Saving creates the item and moves to its edit URL.
  await expect(page).toHaveURL(/\/admin\/posts\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Edit post' })).toBeVisible();
  const id = idFromUrl(page);
  await expect(page.getByLabel('Title')).toHaveValue(title);
  await expect(page.getByLabel('Slug')).not.toHaveValue('');

  // Publish it.
  await page.getByLabel('Status').selectOption('published');
  await page.getByRole('button', { name: 'Update' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved at' })).toBeVisible();

  const published = await page.request.get(`/api/v1/content/post/${id}`);
  const first = ((await published.json()) as { item: Record<string, unknown> }).item;
  expect(first.status).toBe('published');
  expect(first.title).toBe(title);
  expect(JSON.stringify(first.body)).toContain('First version of the text');

  // Change the title and the text, then update.
  await page.getByLabel('Title').fill(`${title} changed`);
  await page.getByRole('textbox', { name: 'Content' }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' and more');
  await page.getByRole('button', { name: 'Update' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved at' })).toBeVisible();

  // The history lists every saved version, newest first.
  const history = page.getByRole('list', { name: 'Revisions' });
  await expect(history.getByRole('listitem')).toHaveCount(3);
  await expect(history.getByRole('listitem').first()).toContainText(`Latest: ${title} changed`);

  // Restore the first version into the form and keep it.
  await page.getByRole('button', { name: `Restore First: ${title} (draft)` }).click();
  await expect(page.getByLabel('Title')).toHaveValue(title);
  await page.getByRole('button', { name: 'Update' }).click();
  await expect(history.getByRole('listitem')).toHaveCount(4);

  const restored = await page.request.get(`/api/v1/content/post/${id}`);
  const item = ((await restored.json()) as { item: Record<string, unknown> }).item;
  expect(item.title).toBe(title);
  // Restoring brings back the text but leaves the status alone.
  expect(item.status).toBe('published');
  expect(JSON.stringify(item.body)).toContain('First version of the text');
  expect(JSON.stringify(item.body)).not.toContain('and more');
});

test('a draft saves itself after a pause, and a published post does not', async ({ page }) => {
  const title = `Auto${Date.now()}`;
  await signIn(page);
  await page.goto('/admin/posts/new');
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/admin\/posts\/\d+$/);
  const id = idFromUrl(page);

  await page.getByLabel('Title').fill(`${title} edited`);
  await expect(page.getByRole('status').filter({ hasText: 'Saved at' })).toBeVisible({
    timeout: 15_000,
  });
  const draft = await page.request.get(`/api/v1/content/post/${id}`);
  expect(((await draft.json()) as { item: { title: string } }).item.title).toBe(`${title} edited`);

  // Publish, then edit: nothing is saved until the person presses Update.
  await page.getByLabel('Status').selectOption('published');
  await page.getByRole('button', { name: 'Update' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved at' })).toBeVisible();
  await page.getByLabel('Title').fill(`${title} live edit`);
  await expect(page.getByRole('status')).toHaveText('Unsaved changes');
  await page.waitForTimeout(4000);
  await expect(page.getByRole('status')).toHaveText('Unsaved changes');
  const live = await page.request.get(`/api/v1/content/post/${id}`);
  expect(((await live.json()) as { item: { title: string } }).item.title).toBe(`${title} edited`);
});

test('the posts list opens the edit screen', async ({ page }) => {
  const title = `Open${Date.now()}`;
  await signIn(page);
  const me = await page.request.get('/api/v1/auth/me');
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const created = await page.request.post('/api/v1/content/post', {
    headers: { 'x-csrf-token': csrfToken },
    data: { title, status: 'draft' },
  });
  expect(created.status()).toBe(201);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Posts' }).click();
  await page.getByLabel('Search', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { name: 'Edit post' })).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue(title);
});

// A valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('assign a category and a tag and set a featured image', async ({ page }) => {
  const stamp = Date.now();
  const title = `Sidebar${stamp}`;
  const category = `Cat${stamp}`;
  const tag = `tag${stamp}`;
  const alt = `Picture ${stamp}`;
  await signIn(page);
  const me = await page.request.get('/api/v1/auth/me');
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const headers = { 'x-csrf-token': csrfToken };

  // Seed a category and an image through the API, the way another screen would.
  const madeCategory = await page.request.post('/api/v1/taxonomies/category/terms', {
    headers,
    data: { name: category },
  });
  expect(madeCategory.status()).toBe(201);
  const categoryId = ((await madeCategory.json()) as { term: { id: number } }).term.id;
  const upload = await page.request.post('/api/v1/media', {
    headers,
    multipart: { file: { name: `sidebar-${stamp}.png`, mimeType: 'image/png', buffer: PNG } },
  });
  expect(upload.status()).toBe(201);
  const mediaId = ((await upload.json()) as { media: { id: number } }).media.id;
  const altSaved = await page.request.patch(`/api/v1/media/${mediaId}`, {
    headers,
    data: { alt },
  });
  expect(altSaved.ok()).toBe(true);

  await page.goto('/admin/posts/new');
  await page.getByLabel('Title').fill(title);

  // Categories are a checklist.
  await page.getByRole('checkbox', { name: category }).check();

  // A tag that does not exist yet is created on the fly; Enter does not submit the form.
  await page.getByLabel('Add tag').fill(tag);
  await page.getByRole('button', { name: `Create tag “${tag}”` }).click();
  await expect(
    page.getByRole('list', { name: 'Chosen tags' }).getByRole('listitem').filter({ hasText: tag }),
  ).toBeVisible();

  // The featured image comes from the media library.
  await page.getByRole('button', { name: 'Set featured image' }).click();
  await page
    .getByRole('dialog', { name: 'Choose featured image' })
    .getByRole('button', { name: `Use ${alt}` })
    .click();
  await expect(page.getByRole('img', { name: alt })).toBeVisible();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/admin\/posts\/\d+$/);
  const id = idFromUrl(page);

  const saved = await page.request.get(`/api/v1/content/post/${id}`);
  const item = (
    (await saved.json()) as {
      item: {
        meta: { featured_image?: number };
        terms: { category: { id: number }[]; tag: { name: string }[] };
      };
    }
  ).item;
  expect(item.terms.category.map((t) => t.id)).toEqual([categoryId]);
  expect(item.terms.tag.map((t) => t.name)).toEqual([tag]);
  expect(item.meta.featured_image).toBe(mediaId);

  // The saved choices come back when the screen is reopened, and can be removed again.
  await page.reload();
  await expect(page.getByRole('checkbox', { name: category })).toBeChecked();
  await page.getByRole('button', { name: `Remove tag ${tag}` }).click();
  await page.getByRole('button', { name: 'Remove featured image' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved at' })).toBeVisible();
  const cleared = await page.request.get(`/api/v1/content/post/${id}`);
  const after = ((await cleared.json()) as { item: { meta: object; terms: { tag: unknown[] } } })
    .item;
  expect(after.terms.tag).toEqual([]);
  expect(after.meta).toEqual({});
});

test('compare a revision with the form', async ({ page }) => {
  const title = `Diff${Date.now()}`;
  await signIn(page);
  await page.goto('/admin/posts/new');
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/admin\/posts\/\d+$/);

  await page.getByLabel('Title').fill(`${title} renamed`);
  await page.getByRole('button', { name: `Compare Latest: ${title} (draft)` }).click();
  const diff = page.getByRole('region', { name: 'Changes since this version' });
  await expect(diff).toContainText(`Removed: ${title}`);
  await expect(diff).toContainText(`Added: ${title} renamed`);
  await diff.getByRole('button', { name: 'Hide changes' }).click();
  await expect(diff).toBeHidden();
});
