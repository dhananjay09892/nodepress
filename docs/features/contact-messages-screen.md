# Contact messages screen

The admin **Messages** screen (`manage_options`; the sidebar entry is hidden when `GET /api/v1/contact/submissions` answers 403 or 404) lists the messages stored by the contact form, newest first, 20 per page with Previous and Next buttons. Each row shows the date, name, email (a `mailto:` link), the form id, whether the message was emailed (`Emailed`, `Email failed`, `Not emailed (logged)`) and the message text, which is shown as plain text and never as HTML.

The screen registers itself (`apps/admin/src/screens/Messages.screen.tsx`, order 45); see `docs/features/redirects-screen.md`. The data helpers live in `apps/admin/src/messages.ts`.
