/**
 * A reader for WordPress export files (WXR). It has no dependencies: WXR is plain XML with CDATA
 * sections, and the parser below handles exactly what an export needs (elements, text, CDATA,
 * entities, comments, processing instructions) with limits so a hostile file cannot exhaust
 * memory. It never executes or fetches anything.
 */

export const MAX_WXR_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_ITEMS = 100_000;

export class WxrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WxrError';
  }
}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Parse XML into a tree. Attributes are not needed by WXR and are skipped. */
function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, text: '', children: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  const top = (): XmlNode => stack[stack.length - 1] as XmlNode;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      top().text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(xml.slice(i, lt));
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new WxrError('The file ends inside a CDATA section');
      top().text += xml.slice(lt + 9, end);
      i = end + 3;
    } else if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new WxrError('The file ends inside a comment');
      i = end + 3;
    } else if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      if (end === -1) throw new WxrError('The file ends inside a declaration');
      i = end + 1;
    } else {
      const end = findTagEnd(xml, lt + 1);
      if (end === -1) throw new WxrError('The file ends inside a tag');
      const inner = xml.slice(lt + 1, end);
      i = end + 1;
      if (inner.startsWith('/')) {
        const name = inner.slice(1).trim();
        const node = stack.pop();
        if (!node || stack.length === 0 || node.name !== name) {
          throw new WxrError(`Unexpected closing tag </${name}>`);
        }
      } else {
        const selfClosing = inner.endsWith('/');
        const head = (selfClosing ? inner.slice(0, -1) : inner).trim();
        const name = head.split(/\s/, 1)[0] ?? '';
        if (name === '') throw new WxrError('An element has no name');
        const node: XmlNode = {
          name,
          attrs: parseAttrs(head.slice(name.length)),
          text: '',
          children: [],
        };
        top().children.push(node);
        if (!selfClosing) {
          if (stack.length >= MAX_DEPTH) throw new WxrError('The file is nested too deeply');
          stack.push(node);
        }
      }
    }
  }
  if (stack.length !== 1) throw new WxrError(`Element <${top().name}> is never closed`);
  return root;
}

function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    attrs[match[1] as string] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

/** End of a tag, skipping `>` inside quoted attribute values. */
function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let k = from; k < xml.length; k++) {
    const ch = xml[k];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return k;
  }
  return -1;
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}
function childText(node: XmlNode, name: string): string {
  return (child(node, name)?.text ?? '').trim();
}
function childrenOf(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}
function toInt(text: string): number | undefined {
  return /^-?\d+$/.test(text) ? Number(text) : undefined;
}

export interface WxrAuthor {
  login: string;
  email: string;
  displayName: string;
}

export interface WxrTerm {
  /** WordPress term id when the export has one. */
  id?: number;
  slug: string;
  name: string;
  /** Slug of the parent category (categories only). */
  parent?: string;
  description?: string;
}

export interface WxrItemTerm {
  taxonomy: 'category' | 'tag' | string;
  slug: string;
  name: string;
}

export interface WxrComment {
  id?: number;
  author: string;
  authorEmail: string;
  date: string;
  content: string;
  approved: string;
  parent?: number;
}

export interface WxrItem {
  /** WordPress post type: `post`, `page`, `attachment`, ... */
  type: string;
  id?: number;
  title: string;
  /** The item's public URL on the old site. */
  link: string;
  guid: string;
  slug: string;
  /** WordPress status: `publish`, `draft`, `future`, `private`, `pending`, `trash`, `inherit`. */
  status: string;
  /** The date the item was published or created, as written in the file (site local time). */
  date: string;
  /** The same date in GMT (`0000-00-00 00:00:00` when unset). */
  dateGmt: string;
  creator: string;
  content: string;
  excerpt: string;
  /** Id of the parent item (page parent, or the post an attachment belongs to). */
  parent?: number;
  /** For attachments: where the file was on the old site. */
  attachmentUrl?: string;
  terms: WxrItemTerm[];
  meta: Record<string, string>;
  comments: WxrComment[];
}

export interface WxrExport {
  title: string;
  /** The old site's address, no trailing slash. */
  siteUrl: string;
  /** The address the content was written for (often the same). */
  baseUrl: string;
  authors: WxrAuthor[];
  categories: WxrTerm[];
  tags: WxrTerm[];
  items: WxrItem[];
}

function termFrom(node: XmlNode, prefix: 'category' | 'tag'): WxrTerm {
  const slug = childText(node, `wp:${prefix}_nicename`) || childText(node, `wp:${prefix}_slug`);
  const name = childText(node, `wp:cat_name`) || childText(node, `wp:${prefix}_name`);
  const id = toInt(childText(node, 'wp:term_id'));
  const parent = childText(node, 'wp:category_parent');
  const description =
    childText(node, `wp:${prefix}_description`) || childText(node, 'wp:category_description');
  return {
    ...(id !== undefined ? { id } : {}),
    slug,
    name: name || slug,
    ...(parent ? { parent } : {}),
    ...(description ? { description } : {}),
  };
}

function itemFrom(node: XmlNode): WxrItem {
  const meta: Record<string, string> = {};
  for (const m of childrenOf(node, 'wp:postmeta')) {
    const key = childText(m, 'wp:meta_key');
    if (key) meta[key] = childText(m, 'wp:meta_value');
  }
  const comments: WxrComment[] = childrenOf(node, 'wp:comment').map((c) => {
    const id = toInt(childText(c, 'wp:comment_id'));
    const parent = toInt(childText(c, 'wp:comment_parent'));
    return {
      ...(id !== undefined ? { id } : {}),
      author: childText(c, 'wp:comment_author'),
      authorEmail: childText(c, 'wp:comment_author_email'),
      date: childText(c, 'wp:comment_date'),
      content: child(c, 'wp:comment_content')?.text ?? '',
      approved: childText(c, 'wp:comment_approved'),
      ...(parent ? { parent } : {}),
    };
  });
  const id = toInt(childText(node, 'wp:post_id'));
  const parent = toInt(childText(node, 'wp:post_parent'));
  const attachmentUrl = childText(node, 'wp:attachment_url');
  return {
    type: childText(node, 'wp:post_type') || 'post',
    ...(id !== undefined ? { id } : {}),
    title: childText(node, 'title'),
    link: childText(node, 'link'),
    guid: childText(node, 'guid'),
    slug: childText(node, 'wp:post_name'),
    status: childText(node, 'wp:status'),
    date: childText(node, 'wp:post_date'),
    dateGmt: childText(node, 'wp:post_date_gmt'),
    creator: childText(node, 'dc:creator'),
    content: child(node, 'content:encoded')?.text ?? '',
    excerpt: child(node, 'excerpt:encoded')?.text ?? '',
    ...(parent ? { parent } : {}),
    ...(attachmentUrl ? { attachmentUrl } : {}),
    terms: termsOf(node),
    meta,
    comments,
  };
}

/** Item categories carry their taxonomy in attributes: `<category domain="post_tag" nicename="trip">`. */
function termsOf(node: XmlNode): WxrItemTerm[] {
  const terms: WxrItemTerm[] = [];
  for (const c of childrenOf(node, 'category')) {
    const domain = c.attrs['domain'] ?? '';
    const nicename = c.attrs['nicename'] ?? '';
    const name = c.text.trim();
    if (domain && (name || nicename)) {
      terms.push({
        taxonomy: domain === 'post_tag' ? 'tag' : domain,
        slug: nicename,
        name: name || nicename,
      });
    }
  }
  return terms;
}

/** Read a WXR export. Throws `WxrError` for a file that is not a WordPress export. */
export function parseWxr(xml: string): WxrExport {
  if (typeof xml !== 'string' || xml.trim() === '') throw new WxrError('The file is empty');
  if (xml.length > MAX_WXR_BYTES) throw new WxrError('The file is too large');
  const tree = parseXml(xml);
  const rss = child(tree, 'rss');
  const channel = rss ? child(rss, 'channel') : undefined;
  if (!channel) throw new WxrError('This is not a WordPress export (no <rss><channel>)');
  const itemNodes = childrenOf(channel, 'item');
  if (itemNodes.length > MAX_ITEMS)
    throw new WxrError(`The export has more than ${MAX_ITEMS} items`);

  const clean = (url: string): string => url.trim().replace(/\/+$/, '');
  const siteUrl = clean(childText(channel, 'wp:base_site_url') || childText(channel, 'link'));
  return {
    title: childText(channel, 'title'),
    siteUrl,
    baseUrl: clean(childText(channel, 'wp:base_blog_url') || siteUrl),
    authors: childrenOf(channel, 'wp:author').map((a) => ({
      login: childText(a, 'wp:author_login'),
      email: childText(a, 'wp:author_email'),
      displayName: childText(a, 'wp:author_display_name') || childText(a, 'wp:author_login'),
    })),
    categories: childrenOf(channel, 'wp:category').map((c) => termFrom(c, 'category')),
    tags: childrenOf(channel, 'wp:tag').map((t) => termFrom(t, 'tag')),
    items: itemNodes.map(itemFrom),
  };
}
