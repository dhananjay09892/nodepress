import type { TemplateProps } from '@nodepress/core';
import type { Child } from 'hono/jsx';

/** The page frame shared by every Aurora template: skip link, header, main landmark, footer. */
export function Layout(props: {
  page: TemplateProps;
  title: string;
  /** Only the front page uses the bare site name as its title. */
  isFront?: boolean;
  children?: Child;
}) {
  const { page, title, isFront, children } = props;
  const documentTitle = isFront ? page.siteName : `${title} | ${page.siteName}`;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        {page.tagline ? <meta name="description" content={page.tagline} /> : null}
        <title>{documentTitle}</title>
        <link rel="stylesheet" href={`${page.theme.assetsUrl}/style.css`} />
      </head>
      <body class="np-aurora">
        <a class="np-aurora-skip" href="#main">
          Skip to content
        </a>
        <header class="np-aurora-header">
          <div class="np-aurora-wrap np-aurora-header-row">
            <a
              class="np-aurora-brand"
              href="/"
              aria-current={page.path === '/' ? 'page' : undefined}
            >
              {page.siteName}
            </a>
            <nav aria-label="Primary">
              <a href="/" aria-current={page.path === '/' ? 'page' : undefined}>
                Home
              </a>
            </nav>
          </div>
        </header>
        <main id="main" class="np-aurora-wrap np-aurora-main" tabindex="-1">
          {children}
        </main>
        <footer class="np-aurora-footer">
          <div class="np-aurora-wrap">
            <p>
              &copy; {page.siteName}. Powered by{' '}
              <a href="https://github.com/dhananjay09892/nodepress">NodePress</a>.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
