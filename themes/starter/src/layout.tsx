import type { TemplateProps } from '@nodepress/core';
import type { Child } from 'hono/jsx';

/** The page frame shared by every template of this theme. */
export function Layout(props: { page: TemplateProps; title: string; children?: Child }) {
  const { page, title, children } = props;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} | ${page.siteName}`}</title>
        <link rel="stylesheet" href={`${page.theme.assetsUrl}/style.css`} />
      </head>
      <body class="np-starter">
        <header class="np-starter-header">
          <a href="/">{page.siteName}</a>
        </header>
        <main class="np-starter-main">{children}</main>
      </body>
    </html>
  );
}
