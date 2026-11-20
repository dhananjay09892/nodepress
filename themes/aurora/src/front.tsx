import type { TemplateProps } from '@nodepress/core';
import { raw } from 'hono/html';
import { PostDate } from './date.js';
import { Layout } from './layout.js';

type Post = NonNullable<TemplateProps['posts']>[number];

function PostList(props: { posts: Post[]; cards: boolean }) {
  const { posts, cards } = props;
  if (posts.length === 0) return <p>No posts yet.</p>;
  return (
    <ul class={cards ? 'np-aurora-cards' : 'np-aurora-posts'}>
      {posts.map(({ content, url }) => (
        <li>
          <article>
            <h3>
              <a href={url}>{content.title}</a>
            </h3>
            <PostDate date={content.publishedAt} />
            {content.excerpt ? <p>{content.excerpt}</p> : null}
          </article>
        </li>
      ))}
    </ul>
  );
}

/**
 * The front page. The `layout` theme setting picks between a blog (intro, then the latest
 * posts) and a business page (hero with the tagline, then the latest news as cards).
 */
export default function Front(page: TemplateProps) {
  const business = page.settings?.layout === 'business';
  const posts = page.posts ?? [];
  const intro = page.html ? <div class="np-aurora-prose">{raw(page.html)}</div> : null;
  return (
    <Layout page={page} title={page.siteName} isFront>
      {business ? (
        <>
          <section class="np-aurora-hero" aria-labelledby="np-aurora-hero-title">
            <h1 id="np-aurora-hero-title">{page.siteName}</h1>
            {page.tagline ? <p class="np-aurora-lead">{page.tagline}</p> : null}
            {intro}
          </section>
          <section aria-labelledby="np-aurora-news">
            <h2 id="np-aurora-news">Latest news</h2>
            <PostList posts={posts} cards />
          </section>
        </>
      ) : (
        <>
          <h1 class="np-aurora-site-title">{page.siteName}</h1>
          {page.tagline ? <p class="np-aurora-lead">{page.tagline}</p> : null}
          {intro}
          <section aria-labelledby="np-aurora-latest">
            <h2 id="np-aurora-latest">Latest posts</h2>
            <PostList posts={posts} cards={false} />
          </section>
        </>
      )}
    </Layout>
  );
}
