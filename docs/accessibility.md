# Admin accessibility

The admin is checked with [axe-core](https://github.com/dequelabs/axe-core) in the Playwright job (`apps/admin/e2e/a11y.spec.ts`, helper in `e2e/a11y.ts`), using the WCAG 2.1 A and AA rule tags. A serious or critical violation fails the job and the failure message lists every violation with its rule and the first elements, so one run shows them all. Moderate and minor findings are printed to the test output (none appeared in the first run).

## What the run covers

- The login screen, empty and with an error message.
- Signed in: dashboard, posts, pages, media library, users, the three settings tabs, menus, widgets, customize, plugins, redirects, messages, import, backup, the new post screen (with the block editor) and the editor preview.
- Redirects with a form error and with a filled table.

## What was fixed

| Finding (rule)                                                                                                                             | Fix                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heading buttons in the editor toolbar showed "H1" to "H4" but were named "Heading 1" and so on (`label-content-name-mismatch`, WCAG 2.5.3) | The accessible name now starts with the visible text: "H1 (Heading 1)" and so on (a first attempt, "Heading 1 (H1)", still failed axe). The keyboard test for the toolbar expects the new name. |

Everything else the run checked passed: names and labels of form fields, color contrast, landmarks (`main`, the `Main` navigation) and heading structure as far as axe tests them.

## Added in N78 (skip link, focus, more states)

- The admin shell has a "Skip to main content" link (the first tab stop, visible when focused) and a focusable `main`, so keyboard users can skip the sidebar.
- A visible `:focus-visible` outline on every control (white inside the dark sidebar).
- More axe states: the web installer, the posts list with content, the edit screen of a saved post, the new post form with a validation error and the editor with text selected.
- Keyboard tests for the skip link and for the focus indicator.

## What is not covered yet (still to do, tracked as N79)

Not tested yet:

- Dialogs and confirmation prompts (delete confirmations, the link prompt in the editor uses `window.prompt`).
- Reading order inside the editor with a screen reader.
- Keyboard operation of the media grid (selecting, deleting) and of the menu tree (the move up/down/indent buttons exist; a keyboard test does not).
- Focus order after navigation, saving and deleting, and whether status messages ("Saved", import progress) are announced: needs manual checks with a screen reader.
- Moderate and minor findings from newer axe rules (`best-practice` tag) are not part of the run.

These are task N79 in `docs/QUEUE.md`.

## Aurora (the default theme)

`apps/admin/e2e/aurora-a11y.spec.ts` runs against the public site in the same Playwright job:

- axe (WCAG 2.1 A and AA, serious and critical fail) on the front page in the blog layout and in the business layout (previewed with `np_preview`), a post, a page, the 404 page and a page with the contact form block, each in light and dark mode, and again at 320 px width.
- No sideways scrolling at 320 px, nor in a 640 px window (what 200 % zoom looks like on a 1280 px screen).
- The skip link is the first tab stop and moves focus to `main`.
- Every page has one `h1` and no skipped heading levels.
- With reduced motion requested, no element has a transition or animation.

The first complete run found nothing to fix: all of these passed, and the Lighthouse job (accessibility 100 on all four audits) stays above 95. The Lighthouse performance score is a separate gate that varies on shared runners (see the fix in the warm-up of that job).

Not covered by automation: reading order with a screen reader, and the contact form's error messages after a failed submit (axe sees the form only in its empty state).
