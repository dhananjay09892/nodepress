/**
 * Conversion between the NodePress block envelope and Tiptap (ProseMirror) JSON.
 *
 * Pure functions with no Tiptap or DOM import, so they run on the server and in
 * plain unit tests. The Tiptap extensions in `tiptap-extensions.ts` define the
 * node and mark names used here.
 *
 * Blocks the editor does not know (for example from a plugin that is not
 * loaded in the admin) become `npUnknown` nodes that carry the original block
 * untouched, so opening and saving a post never destroys them.
 */
import type { Block, BlockAttrs, BlockDocument, Mark, MarkType, TextNode } from './types.js';
import { BLOCK_DOCUMENT_VERSION } from './types.js';

export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: TiptapMark[];
  text?: string;
}

export interface TiptapDoc {
  type: 'doc';
  content: TiptapNode[];
}

const MARK_TO_TIPTAP: Record<MarkType, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strike',
  code: 'code',
  link: 'link',
};
const TIPTAP_TO_MARK = new Map<string, MarkType>(
  Object.entries(MARK_TO_TIPTAP).map(([mark, tiptap]) => [tiptap, mark as MarkType]),
);

/** Attribute names each custom block keeps, in both directions. */
const IMAGE_ATTRS = ['src', 'mediaId', 'alt', 'width', 'height', 'caption'] as const;

function cleanAttrs(attrs: Record<string, unknown> | undefined): BlockAttrs | undefined {
  if (!attrs) return undefined;
  const out: BlockAttrs = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pick(attrs: BlockAttrs | undefined, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (attrs?.[key] !== undefined) out[key] = attrs[key];
  return out;
}

function withAttrs(node: TiptapNode, attrs: Record<string, unknown>): TiptapNode {
  return Object.keys(attrs).length > 0 ? { ...node, attrs } : node;
}

// ---------------------------------------------------------------------------
// Envelope -> Tiptap
// ---------------------------------------------------------------------------

function inlineToTiptap(content: readonly TextNode[] | undefined): TiptapNode[] {
  const out: TiptapNode[] = [];
  for (const node of content ?? []) {
    if (node.text === '') continue; // ProseMirror rejects empty text nodes
    const marks: TiptapMark[] = (node.marks ?? []).map((mark) =>
      mark.type === 'link'
        ? { type: 'link', attrs: { href: mark.href ?? '' } }
        : { type: MARK_TO_TIPTAP[mark.type] },
    );
    out.push(marks.length > 0 ? { type: 'text', text: node.text, marks } : { type: 'text', text: node.text });
  }
  return out;
}

function inlineNode(type: string, block: Block, attrs: Record<string, unknown> = {}): TiptapNode {
  const content = inlineToTiptap(block.content);
  return withAttrs(content.length > 0 ? { type, content } : { type }, attrs);
}

function blocksToTiptap(blocks: readonly Block[] | undefined): TiptapNode[] {
  return (blocks ?? []).map(blockToTiptap);
}

/** A column or list item must hold at least one block in the editor schema. */
function atLeastOneBlock(nodes: TiptapNode[]): TiptapNode[] {
  return nodes.length > 0 ? nodes : [{ type: 'paragraph' }];
}

export function blockToTiptap(block: Block): TiptapNode {
  const attrs = block.attrs;
  switch (block.type) {
    case 'core/paragraph':
      return inlineNode('paragraph', block);
    case 'core/heading':
      return inlineNode('heading', block, { level: attrs?.['level'] ?? 2 });
    case 'core/quote':
      return inlineNode('npQuote', block, pick(attrs, ['citation']));
    case 'core/code': {
      const text = (block.content ?? []).map((node) => node.text).join('');
      const language = attrs?.['language'];
      return withAttrs(
        text !== '' ? { type: 'codeBlock', content: [{ type: 'text', text }] } : { type: 'codeBlock' },
        typeof language === 'string' ? { language } : {},
      );
    }
    case 'core/list': {
      const items = (block.children ?? []).map((item): TiptapNode => {
        const first = inlineNode('paragraph', item);
        return { type: 'listItem', content: [first, ...blocksToTiptap(item.children)] };
      });
      return { type: attrs?.['ordered'] === true ? 'orderedList' : 'bulletList', content: items };
    }
    case 'core/image':
      return withAttrs({ type: 'npImage' }, pick(attrs, IMAGE_ATTRS));
    case 'core/embed':
      return withAttrs({ type: 'npEmbed' }, pick(attrs, ['url']));
    case 'core/button':
      return withAttrs({ type: 'npButton' }, pick(attrs, ['text', 'href', 'style']));
    case 'core/columns':
      return {
        type: 'npColumns',
        content: (block.children ?? []).map(
          (column): TiptapNode => ({
            type: 'npColumn',
            content: atLeastOneBlock(blocksToTiptap(column.children)),
          }),
        ),
      };
    default:
      return { type: 'npUnknown', attrs: { block } };
  }
}

export function envelopeToTiptap(doc: BlockDocument | null | undefined): TiptapDoc {
  const content = blocksToTiptap(doc?.blocks);
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

// ---------------------------------------------------------------------------
// Tiptap -> Envelope
// ---------------------------------------------------------------------------

function inlineFromTiptap(nodes: readonly TiptapNode[] | undefined): TextNode[] {
  const out: TextNode[] = [];
  for (const node of nodes ?? []) {
    if (node.type !== 'text' || !node.text) continue;
    const marks: Mark[] = [];
    for (const mark of node.marks ?? []) {
      const type = TIPTAP_TO_MARK.get(mark.type);
      if (!type) continue;
      if (type === 'link') {
        const href = mark.attrs?.['href'];
        if (typeof href === 'string' && href !== '') marks.push({ type, href });
      } else {
        marks.push({ type });
      }
    }
    out.push(marks.length > 0 ? { text: node.text, marks } : { text: node.text });
  }
  return out;
}

function textBlock(type: string, node: TiptapNode, attrs?: BlockAttrs): Block {
  const content = inlineFromTiptap(node.content);
  return {
    type,
    ...(attrs ? { attrs } : {}),
    ...(content.length > 0 ? { content } : {}),
  };
}

function withBlockAttrs(block: Block, attrs: BlockAttrs | undefined): Block {
  return attrs ? { ...block, attrs } : block;
}

function listItemFromTiptap(item: TiptapNode): Block {
  const [first, ...rest] = item.content ?? [];
  const head = first?.type === 'paragraph' ? first : undefined;
  const nested = (head ? rest : (item.content ?? [])).map(blockFromTiptap);
  const content = inlineFromTiptap(head?.content);
  return {
    type: 'core/list-item',
    ...(content.length > 0 ? { content } : {}),
    ...(nested.length > 0 ? { children: nested } : {}),
  };
}

export function blockFromTiptap(node: TiptapNode): Block {
  const attrs = cleanAttrs(node.attrs);
  switch (node.type) {
    case 'paragraph':
      return textBlock('core/paragraph', node);
    case 'heading':
      return textBlock('core/heading', node, { level: node.attrs?.['level'] ?? 2 });
    case 'npQuote':
      return textBlock('core/quote', node, cleanAttrs(pick(attrs, ['citation'])));
    case 'codeBlock': {
      const text = (node.content ?? []).map((child) => child.text ?? '').join('');
      const language = node.attrs?.['language'];
      return {
        type: 'core/code',
        ...(typeof language === 'string' && language !== '' ? { attrs: { language } } : {}),
        ...(text !== '' ? { content: [{ text }] } : {}),
      };
    }
    case 'bulletList':
    case 'orderedList':
      return {
        type: 'core/list',
        attrs: { ordered: node.type === 'orderedList' },
        children: (node.content ?? []).map(listItemFromTiptap),
      };
    case 'npImage':
      return withBlockAttrs({ type: 'core/image' }, cleanAttrs(pick(attrs, IMAGE_ATTRS)));
    case 'npEmbed':
      return withBlockAttrs({ type: 'core/embed' }, cleanAttrs(pick(attrs, ['url'])));
    case 'npButton':
      return withBlockAttrs({ type: 'core/button' }, cleanAttrs(pick(attrs, ['text', 'href', 'style'])));
    case 'npColumns':
      return {
        type: 'core/columns',
        children: (node.content ?? []).map((column) => ({
          type: 'core/column',
          children: (column.content ?? []).map(blockFromTiptap),
        })),
      };
    case 'npUnknown': {
      const original = node.attrs?.['block'];
      if (original && typeof original === 'object') return original as Block;
      return { type: 'core/paragraph' };
    }
    default:
      // Anything else the editor produced is kept as plain text rather than lost.
      return textBlock('core/paragraph', node);
  }
}

export function tiptapToEnvelope(doc: TiptapDoc | TiptapNode): BlockDocument {
  return {
    version: BLOCK_DOCUMENT_VERSION,
    blocks: (doc.content ?? []).map(blockFromTiptap),
  };
}
