import { escapeHtml, safeUrl } from './html.js';
import type { Mark, TextNode } from './types.js';

const TAGS: Record<Exclude<Mark['type'], 'link'>, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
};

export function renderInline(nodes: readonly TextNode[] | undefined): string {
  if (!nodes) return '';
  return nodes.map(renderTextNode).join('');
}

function renderTextNode(node: TextNode): string {
  let html = escapeHtml(node.text);
  for (const mark of node.marks ?? []) {
    if (mark.type === 'link') {
      const href = safeUrl(mark.href);
      // An unsafe link degrades to plain text instead of a dangerous href.
      if (href) html = `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${html}</a>`;
    } else {
      const tag = TAGS[mark.type];
      if (tag) html = `<${tag}>${html}</${tag}>`;
    }
  }
  return html;
}

export function plainText(nodes: readonly TextNode[] | undefined): string {
  return (nodes ?? []).map((n) => n.text).join('');
}
