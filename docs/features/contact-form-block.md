# Contact form block and SMTP mail

## The block

`core/contact-form` draws a labelled form (name, email, message) that posts to `/api/v1/contact`. Attributes, all optional: `form` (an id of 1-40 lowercase letters, digits and dashes, shown in the Messages list and the mail subject, default `contact`), `submitLabel` and `successMessage`. Add it in the editor with the "Contact form" toolbar button.

- Every field has a `<label>` and an error line that screen readers announce (`role="alert"`); the button and the status line use `aria-live`. Style it with the classes `np-contact-form`, `np-field`, `np-field-error`, `np-contact-status` (plus `np-contact-success` or `np-contact-error`) and `np-button`.
- A hidden `website` field is the honeypot: people never fill it in, scripts do.
- Pages are cached, so the signed time token is not part of the HTML. `/np/contact-form.js` (served by the server, allowed by the default Content-Security-Policy) fetches it from `/api/v1/contact/token`, waits until the form is old enough, posts the JSON and puts field errors next to the fields.
- Without JavaScript the form cannot be sent; a `<noscript>` note says so (a signed token cannot be put in a cached page).

## Mail

Set `CONTACT_TO` (where messages go), `MAIL_URL` and `MAIL_FROM` to email messages:

```
MAIL_URL=smtps://user:password@smtp.example.com:465   # or smtp://…:587 (STARTTLS)
MAIL_FROM=site@example.com
```

`createSmtpMailAdapter` (core) checks every address again and strips line breaks from the subject so a message cannot add headers; `nodemailer` is only loaded when `MAIL_URL` is set. A wrong `MAIL_URL`, a missing `MAIL_FROM` or a missing library is a warning in the log and mail falls back to being logged; a failed send never loses a message (it is stored with `mailStatus: failed`).
