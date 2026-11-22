import type { MenuItem, TemplateProps } from '@nodepress/core';
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';

const FONTS: Record<string, string> = {
  system: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
};
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * CSS for the customizer's settings. Values are checked here as well as by the server, so only
 * a hex colour and a known font ever reach the stylesheet. The accent replaces the light-scheme
 * link and focus colours; dark mode keeps its own (a light accent on a dark page is not safe).
 */
export function customCss(settings: Record<string, unknown> | undefined): string {
  const accent = settings?.accent;
  const font = settings?.font;
  let css = '';
  if (typeof accent === 'string' && HEX.test(accent) && accent.toLowerCase() !== '#0b5cad') {
    css +=
      `:root{--link:${accent};--focus:${accent}}` +
      '@media (prefers-color-scheme: dark){:root{--link:#8ab4f8;--focus:#8ab4f8}}';
  }
  if (typeof font === 'string' && font !== 'system' && FONTS[font]) {
    css += `body.np-aurora{font-family:${FONTS[font]}}`;
  }
  return css;
}

/** JSON for a `<script type="application/ld+json">`: `<`, `>`, `&` and line separators are escaped so nothing can close the tag. */
export function jsonLdScript(data: Record<string, unknown>): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

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
  const logo = typeof page.settings?.logo === 'string' ? page.settings.logo : '';
  const meta = page.meta;
  const description = meta?.description ?? page.tagline;
  const documentTitle = isFront ? page.siteName : `${title} | ${page.siteName}`;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        {description ? <meta name="description" content={description} /> : null}
        {meta?.robots ? <meta name="robots" content={meta.robots} /> : null}
        <title>{meta?.title ?? documentTitle}</title>
        {meta?.canonical ? <link rel="canonical" href={meta.canonical} /> : null}
        {meta?.feedUrl ? (
          <link
            rel="alternate"
            type="application/rss+xml"
            title={page.siteName}
            href={meta.feedUrl}
          />
        ) : null}
        {meta ? (
          <>
            <meta property="og:title" content={meta.og.title} />
            <meta property="og:description" content={meta.og.description} />
            <meta property="og:type" content={meta.og.type} />
            {meta.og.url ? <meta property="og:url" content={meta.og.url} /> : null}
            <meta property="og:site_name" content={meta.og.siteName} />
            {meta.og.image ? <meta property="og:image" content={meta.og.image} /> : null}
          </>
        ) : null}
        <link rel="stylesheet" href={`${page.theme.assetsUrl}/style.css`} />
        {page.settingsCssUrl ? <link rel="stylesheet" href={page.settingsCssUrl} /> : null}
        {(meta?.jsonLd ?? []).map((data) => (
          <script type="application/ld+json">{raw(jsonLdScript(data))}</script>
        ))}
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
              {logo ? <img class="np-aurora-logo" src={logo} alt="" height="32" /> : null}
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
