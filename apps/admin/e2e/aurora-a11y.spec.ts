import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousViolations, signIn } from './a11y.js';

// Aurora's public pages, checked with axe (WCAG 2.1 A and AA) in light and dark mode and at
// 320 px width, plus the checks axe cannot make: skip link, heading order, reduced motion and
// zoom to 200 %. Results and what remains: docs/accessibility.md.

const tag = Date.now();
const POST = `aurora-post-${tag}`;
const PAGE = `aurora-page-${tag}`;
const CONTACT = `aurora-contact-${tag}`;

const body = [
  { type: 'core/heading', attrs: { level: 2 }, content: [{ text: 'A second-level heading' }] },
  { type: 'core/paragraph', content: [{ text: 'Some paragraph text for the audit.' }] },
  {
    type: 'core/list',
    children: [
      { type: 'core/list-item', content: [{ text: 'First item' }] },
      { type: 'core/list-item', content: [{ text: 'Second item' }] },
    ],
  },
];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const page = await context.newPage();
  await signIn(page);
  const me = await page.request.get('/api/v1/auth/me');
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const make = async (type: 'post' | 'page', title: string, slug: string, blocks: unknown[]) => {
    const res = await page.request.post(`/api/v1/content/${type}`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { title, slug, status: 'published', body: blocks },
    });
    expect(res.status()).toBe(201);
  };
  await make('post', 'Audit post', POST, body);
  await make('page', 'Audit page', PAGE, body);
  await make('page', 'Audit contact', CONTACT, [{ type: 'core/contact-form' }]);
  await context.close();
});

interface Target {
  name: string;
  path: string;
  /** The status the page answers with (the 404 page is still a themed page). */
  status: number;
}

const TARGETS: Target[] = [
  { name: 'front page (blog layout)', path: '/', status: 200 },
  { name: 'post', path: `/${POST}`, status: 200 },
  { name: 'page', path: `/${PAGE}`, status: 200 },
  { name: 'contact form page', path: `/${CONTACT}`, status: 200 },
  { name: '404 page', path: `/no-such-page-${tag}`, status: 404 },
];

async function open(page: Page, target: Target) {
  const res = await page.goto(target.path);
  expect(res?.status()).toBe(target.status);
  await expect(page.locator('main')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

for (const scheme of ['light', 'dark'] as const) {
  for (const target of TARGETS) {
    test(`${target.name}: axe, ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, target);
      await expectNoSeriousViolations(page, `${target.name} (${scheme})`);
    });
  }

  test(`front page (business layout): axe, ${scheme} mode`, async ({ page, context }) => {
    // The layout setting is previewed through `np_preview`, which needs a signed-in editor.
    await signIn(page);
    await page.emulateMedia({ colorScheme: scheme });
    const preview = encodeURIComponent(JSON.stringify({ layout: 'business' }));
    await page.goto(`/?np_preview=${preview}`);
    await expect(page.locator('main')).toBeVisible();
    await page.waitForLoadState('networkidle');
    // The signed-in toolbar of the admin app is not part of the theme.
    await expectNoSeriousViolations(page, `front page, business (${scheme})`);
    await context.clearCookies();
  });
}

test.describe('at 320 px width', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  for (const target of TARGETS) {
    test(`${target.name}: axe and no sideways scrolling`, async ({ page }) => {
      await open(page, target);
      await expectNoSeriousViolations(page, `${target.name} (320 px)`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'the page scrolls sideways at 320 px').toBeLessThanOrEqual(0);
    });
  }
});

test('zoomed to 200 % (a 640 px wide window) nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  for (const target of TARGETS) {
    await open(page, target);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${target.name} scrolls sideways at 200 % zoom`).toBeLessThanOrEqual(0);
  }
});

test('the skip link is the first tab stop and moves focus to the main content', async ({ page }) => {
  await page.goto(`/${PAGE}`);
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible(); // it appears when focused
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
});

test('every page has one h1 and no skipped heading levels', async ({ page }) => {
  for (const target of TARGETS) {
    await open(page, target);
    const levels = await page.evaluate(() =>
      [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1])),
    );
    expect(levels.filter((l) => l === 1), `${target.name}: number of h1`).toHaveLength(1);
    levels.forEach((level, i) => {
      if (i > 0)
        expect(level - levels[i - 1]!, `${target.name}: heading order ${levels.join(',')}`).toBeLessThanOrEqual(1);
    });
  }
});

test('with reduced motion requested, nothing animates or transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const target of TARGETS) {
    await open(page, target);
    const moving = await page.evaluate(() =>
      [...document.querySelectorAll('body, body *')]
        .filter((el) => {
          const s = getComputedStyle(el);
          const seconds = (value: string) => Math.max(...value.split(',').map((v) => parseFloat(v)));
          return seconds(s.transitionDuration) > 0 || seconds(s.animationDuration) > 0;
        })
        .map((el) => el.tagName.toLowerCase() + (el.className ? `.${String(el.className)}` : '')),
    );
    expect(moving, `${target.name}: elements still moving`).toEqual([]);
  }
});
