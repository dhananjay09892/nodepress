import type { TemplateProps } from '@nodepress/core';
import { Layout } from './layout.js';

export default function NotFound(page: TemplateProps) {
  return (
    <Layout page={page} title="Page not found">
      <article class="np-aurora-article">
        <h1>Page not found</h1>
        <p>
          There is nothing at <code>{page.path}</code>. <a href="/">Back to the home page</a>.
        </p>
      </article>
    </Layout>
  );
}
