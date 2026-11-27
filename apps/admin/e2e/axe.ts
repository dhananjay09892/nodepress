import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.1 A and AA rules, the standard the admin is held to. */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export interface Finding {
  id: string;
  impact: string;
  help: string;
  targets: string[];
}

/** Runs axe on the page as it is now and returns the violations as plain, printable data. */
export async function audit(page: Page, exclude: string[] = []): Promise<Finding[]> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  for (const selector of exclude) builder = builder.exclude(selector);
  const results = await builder.analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? 'unknown',
    help: v.help,
    targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
  }));
}

/** Serious and critical violations fail the test; minor and moderate ones are listed in docs/accessibility.md. */
export function blocking(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.impact === 'serious' || f.impact === 'critical');
}

/** Fails with every blocking violation at once, so one CI run shows the whole list. */
export async function expectAccessible(page: Page, exclude: string[] = []): Promise<void> {
  const findings = blocking(await audit(page, exclude));
  expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
}
