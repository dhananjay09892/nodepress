import type { TemplateProps } from '@nodepress/core';
import { raw } from 'hono/html';
import { Layout } from './layout.js';

/** One post, page or custom item. `page.html` is trusted, already-rendered body HTML. */
export default function Single(page: TemplateProps) {
  const title = page.content?.title ?? page.siteName;
  return (
    <Layout page={page} title={title}>
      <article>
        <h1>{title}</h1>
        {page.content?.excerpt ? <p>{page.content.excerpt}</p> : null}
        {page.html ? raw(page.html) : null}
      </article>
    </Layout>
  );
}
