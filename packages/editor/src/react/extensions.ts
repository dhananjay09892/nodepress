/**
 * Tiptap extensions for the NodePress core blocks. This is the only module
 * (with `BlockEditor.tsx`) that imports Tiptap. Node and mark names must stay in
 * sync with `../tiptap-json.ts`.
 *
 * Paragraph, heading, lists, code block and the inline marks come from
 * StarterKit; the rest are NodePress nodes, prefixed `np`.
 */
import { mergeAttributes, Node, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

/** Declares attributes that default to null (null attributes are not written to HTML). */
function nullableAttrs(...names: string[]): Record<string, { default: null }> {
  return Object.fromEntries(names.map((name) => [name, { default: null }]));
}

const NpQuote = Node.create({
  name: 'npQuote',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return nullableAttrs('citation');
  },
  parseHTML() {
    return [{ tag: 'blockquote' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['blockquote', mergeAttributes(HTMLAttributes), 0];
  },
});

const NpImage = Node.create({
  name: 'npImage',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { ...nullableAttrs('src', 'mediaId', 'width', 'height', 'caption'), alt: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'figure[data-np-block="image"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const src = typeof node.attrs['src'] === 'string' ? node.attrs['src'] : '';
    return [
      'figure',
      mergeAttributes(HTMLAttributes, { 'data-np-block': 'image' }),
      ['img', { src, alt: String(node.attrs['alt'] ?? '') }],
    ];
  },
});

const NpEmbed = Node.create({
  name: 'npEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return nullableAttrs('url');
  },
  parseHTML() {
    return [{ tag: 'figure[data-np-block="embed"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'figure',
      mergeAttributes(HTMLAttributes, { 'data-np-block': 'embed' }),
      `Embed: ${String(node.attrs['url'] ?? '')}`,
    ];
  },
});

const NpButton = Node.create({
  name: 'npButton',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return nullableAttrs('text', 'href', 'style');
  },
  parseHTML() {
    return [{ tag: 'p[data-np-block="button"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'p',
      mergeAttributes(HTMLAttributes, { 'data-np-block': 'button' }),
      `Button: ${String(node.attrs['text'] ?? '')}`,
    ];
  },
});

const NpColumn = Node.create({
  name: 'npColumn',
  content: 'block+',
  isolating: true,
  parseHTML() {
    return [{ tag: 'div[data-np-block="column"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-np-block': 'column' }), 0];
  },
});

const NpColumns = Node.create({
  name: 'npColumns',
  group: 'block',
  content: 'npColumn{2,6}',
  isolating: true,
  parseHTML() {
    return [{ tag: 'div[data-np-block="columns"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-np-block': 'columns' }), 0];
  },
});

/** Holds a block from a plugin the admin does not know, so saving never drops it. */
const NpUnknown = Node.create({
  name: 'npUnknown',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { block: { default: null, rendered: false } };
  },
  parseHTML() {
    return [{ tag: 'div[data-np-block="unknown"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const block = node.attrs['block'] as { type?: unknown } | null;
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-np-block': 'unknown' }),
      `Block not available in this editor: ${String(block?.type ?? 'unknown')}`,
    ];
  },
});

export function createExtensions(): Extensions {
  return [
    StarterKit.configure({
      // Replaced by NodePress nodes or not representable in the block envelope.
      blockquote: false,
      horizontalRule: false,
      hardBreak: false,
      link: { openOnClick: false },
    }),
    NpQuote,
    NpImage,
    NpEmbed,
    NpButton,
    NpColumn,
    NpColumns,
    NpUnknown,
  ];
}
