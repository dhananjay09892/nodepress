# Strict styles (no `'unsafe-inline'`)

The default Content-Security-Policy is `style-src 'self'`, and the admin's own policy is the same: no `<style>` tags and no `style="…"` attributes in markup. Setting styles from script (`element.style.x = …`, `style.cssText`, `style.setProperty`) is still allowed, so React's `style={{…}}` props keep working.

What changed to make that possible:

- **Theme settings are a stylesheet.** A theme may have a `style` template (`templates/style.*`, same file types as other templates) whose default export receives `{ settings, theme, … }` and returns CSS as a string. The server serves it at `/np/theme.css`, and every themed page gets `settingsCssUrl` in its props (`/np/theme.css?v=<hash of the css>`; unset when there is no `style` template or it made no CSS). Link it in `<head>` instead of writing a `<style>` tag. The address changes with the CSS, so browsers cache it (1 hour) without showing an old look. In the customizer preview (`?np_preview=`) the link carries the unsaved values and is only served that way to a user who may edit theme options, with `Cache-Control: no-store`. A `style` template that throws or returns more than 64 KB gives an empty stylesheet. Aurora's `style` template returns the accent and font rules it used to put in a `<style>` tag.
- **The web installer** has its stylesheet at `/install/install.css`.
- **The contact form block** marks its honeypot with the `hidden` attribute; `/np/contact-form.js` moves it off screen through the style object once it runs.
- **The editor** (Tiptap) is created with `injectCSS: false`; the ProseMirror rules it needs are in the admin's `styles.css`.

A theme or plugin that still writes inline styles will see them blocked. Fix it with a stylesheet, classes or CSS variables set from script; `CONTENT_SECURITY_POLICY` can replace the policy for a site that must allow them (see `security-headers.md`).
