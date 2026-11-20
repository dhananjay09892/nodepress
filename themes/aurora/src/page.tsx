import type { TemplateProps } from '@nodepress/core';
import { raw } from 'hono/html';
import { Layout } from './layout.js';

/** A static page: like a post, without the date. */
export default function Page(page: TemplateProps) {
  const title = page.content?.title ?? page.siteName;
  return (
    <Layout page={page} title={title}>
      <article class="np-aurora-article">
        <h1>{title}</h1>
        {page.content?.excerpt ? <p class="np-aurora-lead">{page.content.excerpt}</p> : null}
        {page.html ? <div class="np-aurora-prose">{raw(page.html)}</div> : null}
      </article>
    </Layout>
  );
}
