# Accessibility of the admin

The admin is held to WCAG 2.1 level A and AA. `apps/admin/e2e/a11y.spec.ts` runs
[axe-core](https://github.com/dequelabs/axe-core) (`@axe-core/playwright`, tags `wcag2a`, `wcag2aa`,
`wcag21a`, `wcag21aa`) as part of the Playwright job. A **serious or critical** violation fails the run;
minor and moderate ones are not blocking and are listed below.

## What is audited

| State | How |
| --- | --- |
| Login screen, and with a wrong-password error | `a11y.spec.ts` |
| Web installer | `a11y.spec.ts` |
| Dashboard, Posts, Pages, Media, Users, Settings (general, reading, permalinks), Menus, Widgets, Plugins, Customize, Redirects, Import, Backup, Messages | one test per screen |
| Add post and add page forms, and the edit screen of a saved post | `a11y.spec.ts` |
| Posts list with content | `a11y.spec.ts` |
| A form with a field error (Redirects) and a save with nothing to save (new post) | `a11y.spec.ts` |
| The editor with text selected and bold applied | `a11y.spec.ts` |

Run it locally with `pnpm build && pnpm --filter @nodepress/admin e2e a11y`.

## Fixed in N71

- **Editor toolbar:** the heading buttons showed `H1` to `H4` but were named `Heading 1` to `Heading 4`,
  so the visible text was not part of the accessible name (WCAG 2.5.3, Label in Name). The buttons now
  show their full name.
- **Skip link and landmark:** the shell has a "Skip to main content" link (visible on focus) that moves
  focus to the `<main>` element (WCAG 2.4.1).
- **Visible focus:** a global `:focus-visible` outline (blue on the light background, white inside the
  dark sidebar) so every control shows where the keyboard focus is (WCAG 2.4.7).

Every other screen in the table passed the serious and critical rules on the first run.

## What remains

axe finds roughly a third of accessibility problems; the rest needs a person. Not yet covered:

- **Dialogs** (the menu delete confirmation, the plugin permission review): not in the axe run yet.
- **Media grid and menu tree keyboard operation** are covered by their own Playwright tests for the
  main actions, but not by a systematic keyboard walk through every control.
- **Live regions:** status and error messages use `role="status"` or `role="alert"`; a screen reader
  pass has not been done.
- **Color contrast** is checked by axe only for the states the audit renders (not hover states or
  disabled controls).
- **Minor and moderate axe findings** are not collected by the run. The helper `audit()` in
  `e2e/axe.ts` returns them if someone wants a list.
