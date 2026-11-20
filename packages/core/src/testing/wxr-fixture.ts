/** A small WordPress export used by the importer tests. */
export const WXR_FIXTURE = `<?xml version="1.0" encoding="UTF-8" ?>
<!-- generator="WordPress/6.5" created="2024-05-01 10:00" -->
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>Old &amp; Gold</title>
  <link>https://old.example.com</link>
  <wp:base_site_url>https://old.example.com</wp:base_site_url>
  <wp:base_blog_url>https://old.example.com</wp:base_blog_url>
  <wp:author>
    <wp:author_id>2</wp:author_id>
    <wp:author_login><![CDATA[jane]]></wp:author_login>
    <wp:author_email><![CDATA[jane@example.com]]></wp:author_email>
    <wp:author_display_name><![CDATA[Jane Doe]]></wp:author_display_name>
  </wp:author>
  <wp:category>
    <wp:term_id>3</wp:term_id>
    <wp:category_nicename><![CDATA[travel-italy]]></wp:category_nicename>
    <wp:category_parent><![CDATA[travel]]></wp:category_parent>
    <wp:cat_name><![CDATA[Italy]]></wp:cat_name>
  </wp:category>
  <wp:category>
    <wp:term_id>2</wp:term_id>
    <wp:category_nicename><![CDATA[travel]]></wp:category_nicename>
    <wp:category_parent><![CDATA[]]></wp:category_parent>
    <wp:cat_name><![CDATA[Travel]]></wp:cat_name>
    <wp:category_description><![CDATA[Trips]]></wp:category_description>
  </wp:category>
  <wp:tag>
    <wp:term_id>5</wp:term_id>
    <wp:tag_slug><![CDATA[rome]]></wp:tag_slug>
    <wp:tag_name><![CDATA[Rome]]></wp:tag_name>
  </wp:tag>
  <item>
    <title>About us</title>
    <link>https://old.example.com/about/</link>
    <dc:creator><![CDATA[jane]]></dc:creator>
    <guid isPermaLink="false">https://old.example.com/?page_id=10</guid>
    <content:encoded><![CDATA[<p>We are <strong>old</strong> and gold. See <a href="https://old.example.com/2024/05/hello-rome/">our Rome post</a>.</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>10</wp:post_id>
    <wp:post_date><![CDATA[2024-01-02 09:00:00]]></wp:post_date>
    <wp:post_date_gmt><![CDATA[2024-01-02 08:00:00]]></wp:post_date_gmt>
    <wp:post_name><![CDATA[about]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:post_type><![CDATA[page]]></wp:post_type>
  </item>
  <item>
    <title>Team</title>
    <link>https://old.example.com/about/team/</link>
    <dc:creator><![CDATA[jane]]></dc:creator>
    <content:encoded><![CDATA[Just us.

Two people.]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>11</wp:post_id>
    <wp:post_date_gmt><![CDATA[2024-01-03 08:00:00]]></wp:post_date_gmt>
    <wp:post_name><![CDATA[team]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_parent>10</wp:post_parent>
    <wp:post_type><![CDATA[page]]></wp:post_type>
  </item>
  <item>
    <title>Hello Rome</title>
    <link>https://old.example.com/2024/05/hello-rome/</link>
    <dc:creator><![CDATA[jane]]></dc:creator>
    <content:encoded><![CDATA[<!-- wp:paragraph --><p>Ciao! Back to <a href="/about/">about</a> or the <a href="https://old.example.com/?page_id=11">team</a>, or <a href="https://elsewhere.test/x">elsewhere</a>.</p><!-- /wp:paragraph --><h2>Food</h2><ul><li>Pasta</li><li>Pizza</li></ul><img src="https://old.example.com/wp-content/uploads/rome.jpg" alt="Rome"><script>alert(1)</script>]]></content:encoded>
    <excerpt:encoded><![CDATA[Ciao]]></excerpt:encoded>
    <wp:post_id>20</wp:post_id>
    <wp:post_date_gmt><![CDATA[2024-05-01 10:00:00]]></wp:post_date_gmt>
    <wp:post_name><![CDATA[hello-rome]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <category domain="category" nicename="travel-italy"><![CDATA[Italy]]></category>
    <category domain="post_tag" nicename="rome"><![CDATA[Rome]]></category>
    <category domain="post_tag" nicename="new-tag"><![CDATA[New Tag]]></category>
    <category domain="series" nicename="s1"><![CDATA[Series 1]]></category>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key>
      <wp:meta_value><![CDATA[30]]></wp:meta_value>
    </wp:postmeta>
    <wp:comment>
      <wp:comment_id>1</wp:comment_id>
      <wp:comment_author><![CDATA[Bob]]></wp:comment_author>
      <wp:comment_author_email><![CDATA[bob@example.com]]></wp:comment_author_email>
      <wp:comment_date><![CDATA[2024-05-02 10:00:00]]></wp:comment_date>
      <wp:comment_content><![CDATA[Nice!]]></wp:comment_content>
      <wp:comment_approved><![CDATA[1]]></wp:comment_approved>
      <wp:comment_parent>0</wp:comment_parent>
    </wp:comment>
  </item>
  <item>
    <title>Draft idea</title>
    <link>https://old.example.com/?p=21</link>
    <dc:creator><![CDATA[ghost]]></dc:creator>
    <content:encoded><![CDATA[<p>Not yet</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>21</wp:post_id>
    <wp:post_date_gmt><![CDATA[0000-00-00 00:00:00]]></wp:post_date_gmt>
    <wp:post_name><![CDATA[]]></wp:post_name>
    <wp:status><![CDATA[draft]]></wp:status>
    <wp:post_type><![CDATA[post]]></wp:post_type>
  </item>
  <item>
    <title>Coming soon</title>
    <link>https://old.example.com/2099/01/coming-soon/</link>
    <dc:creator><![CDATA[jane]]></dc:creator>
    <content:encoded><![CDATA[<p>Later</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>22</wp:post_id>
    <wp:post_date_gmt><![CDATA[2099-01-01 00:00:00]]></wp:post_date_gmt>
    <wp:post_name><![CDATA[coming-soon]]></wp:post_name>
    <wp:status><![CDATA[future]]></wp:status>
    <wp:post_type><![CDATA[post]]></wp:post_type>
  </item>
  <item>
    <title>rome.jpg</title>
    <link>https://old.example.com/2024/05/hello-rome/rome-jpg/</link>
    <dc:creator><![CDATA[jane]]></dc:creator>
    <content:encoded><![CDATA[]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>30</wp:post_id>
    <wp:post_name><![CDATA[rome-jpg]]></wp:post_name>
    <wp:status><![CDATA[inherit]]></wp:status>
    <wp:post_parent>20</wp:post_parent>
    <wp:post_type><![CDATA[attachment]]></wp:post_type>
    <wp:attachment_url><![CDATA[https://old.example.com/wp-content/uploads/rome.jpg]]></wp:attachment_url>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_wp_attachment_image_alt]]></wp:meta_key>
      <wp:meta_value><![CDATA[The Colosseum]]></wp:meta_value>
    </wp:postmeta>
  </item>
  <item>
    <title>Product</title>
    <link>https://old.example.com/product/mug/</link>
    <wp:post_id>40</wp:post_id>
    <wp:post_name><![CDATA[mug]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_type><![CDATA[product]]></wp:post_type>
  </item>
</channel>
</rss>
`;
