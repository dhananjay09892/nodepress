import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const EMAIL = 'admin@example.test';
export const PASSWORD = 'e2e-test-password-1';

export async function signIn(page: Page) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
}

/** WCAG 2.1 A and AA rules, the same set the accessibility doc promises. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Runs axe on the current page and fails on serious or critical violations. The message lists
 * every violation with its rule, impact and the first few elements, so one CI run shows all of
 * them. Minor and moderate ones are returned for the caller to log.
 */
export async function expectNoSeriousViolations(page: Page, label: string, exclude: string[] = []) {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  for (const selector of exclude) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = blocking
    .map(
      (v) =>
        `- ${v.id} (${v.impact}): ${v.help}\n` +
        v.nodes
          .slice(0, 4)
          .map((n) => `    ${n.target.join(' ')}\n      ${n.html.slice(0, 140)}`)
          .join('\n'),
    )
    .join('\n');
  expect(blocking, `${label}: accessibility violations\n${report}`).toEqual([]);
  return violations.filter((v) => !blocking.includes(v));
}
