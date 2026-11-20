import type { MenuItem, TemplateProps } from '@nodepress/core';
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';

/** A menu as nested lists; the link to the current page is marked with `aria-current`. */
function MenuList(props: { items: MenuItem[]; path: string; nested?: boolean }) {
  const { items, path, nested } = props;
  return (
    <ul class={nested ? 'np-aurora-submenu' : 'np-aurora-menu'}>
      {items.map((item) => (
        <li>
          <a
            href={item.url}
            aria-current={item.url === path ? 'page' : undefined}
            {...(item.target ? { target: item.target, rel: 'noopener noreferrer' } : {})}
          >
            {item.label}
          </a>
          {item.children.length > 0 ? <MenuList items={item.children} path={path} nested /> : null}
        </li>
      ))}
    </ul>
  );
}

/** The page frame shared by every Aurora template: skip link, header, main landmark, footer. */
export function Layout(props: {
  page: TemplateProps;
  title: string;
  /** Only the front page uses the bare site name as its title. */
  isFront?: boolean;
  children?: Child;
}) {
  const { page, title, isFront, children } = props;
  const primary = page.menus?.primary;
  const footer = page.menus?.footer;
  const sidebar = page.widgets?.sidebar;
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
              {primary && primary.length > 0 ? (
                <MenuList items={primary} path={page.path} />
              ) : (
                <a href="/" aria-current={page.path === '/' ? 'page' : undefined}>
                  Home
                </a>
              )}
            </nav>
          </div>
        </header>
        {sidebar && sidebar.length > 0 ? (
          <div class="np-aurora-wrap np-aurora-has-sidebar">
            <main id="main" class="np-aurora-main" tabindex={-1}>
              {children}
            </main>
            <aside class="np-aurora-sidebar" aria-label="Sidebar">
              {sidebar.map((widget) => (
                <section
                  class={`np-aurora-widget np-aurora-widget-${widget.type.replace(/[^a-z0-9-]/g, '-')}`}
                >
                  {widget.title ? <h2 class="np-aurora-widget-title">{widget.title}</h2> : null}
                  {raw(widget.html)}
                </section>
              ))}
            </aside>
          </div>
        ) : (
          <main id="main" class="np-aurora-wrap np-aurora-main" tabindex={-1}>
            {children}
          </main>
        )}
        <footer class="np-aurora-footer">
          <div class="np-aurora-wrap">
            {footer && footer.length > 0 ? (
              <nav aria-label="Footer">
                <MenuList items={footer} path={page.path} />
              </nav>
            ) : null}
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
