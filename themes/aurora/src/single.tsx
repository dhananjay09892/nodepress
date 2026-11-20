import type { TemplateProps } from '@nodepress/core';
import { raw } from 'hono/html';
import { PostDate } from './date.js';
import { Layout } from './layout.js';

/** One post or custom item. `page.html` is trusted, already-rendered body HTML. */
export default function Single(page: TemplateProps) {
  const title = page.content?.title ?? page.siteName;
  return (
    <Layout page={page} title={title}>
      <article class="np-aurora-article">
        <header>
          <h1>{title}</h1>
          <PostDate date={page.content?.publishedAt} />
        </header>
        {page.content?.excerpt ? <p class="np-aurora-lead">{page.content.excerpt}</p> : null}
        {page.html ? <div class="np-aurora-prose">{raw(page.html)}</div> : null}
      </article>
    </Layout>
  );
}
