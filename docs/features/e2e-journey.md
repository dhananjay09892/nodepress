# End-to-end journey

`apps/admin/e2e/journey.spec.ts` follows a new owner through a brand new site on the empty server Playwright starts on port 3101 (see `playwright.config.ts`; `install.spec.ts` runs first and drives the setup wizard itself):

1. install: the site has no users, so visitors are sent to the wizard; the journey finishes the setup through the API when `install.spec.ts` has not run;
2. sign in and write a post (it is a draft, so the public address answers 404);
3. publish it and read it on the public site, with the site name chosen at setup;
4. add a plugin: upload the package, review its permissions, enable it;
5. change the theme: set the accent color in Customize and see it on the front page and on the post.

The other specs in `apps/admin/e2e` cover each screen in depth against the main test site (port 3100). The suite runs in CI as "Admin end-to-end (Playwright)".
